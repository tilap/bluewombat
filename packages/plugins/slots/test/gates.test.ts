import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const node = process.execPath;
const gates = join(dirname(fileURLToPath(import.meta.url)), "../gates");
const parentClean = join(gates, "parent-clean.mjs");
const sensitivePath = join(gates, "sensitive-path.mjs");
const workspaceChanged = join(gates, "workspace-changed.mjs");
const ciGreen = join(gates, "ci-green.mjs");

function sandbox(): string {
  return mkdtempSync(join(tmpdir(), "host-gate-"));
}

function gitInit(dir: string): void {
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "gate@test.local"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "Gate Test"]);
  execFileSync("git", ["-C", dir, "config", "commit.gpgsign", "false"]);
}

function gitCommit(dir: string, message: string): void {
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-qm", message]);
}

function run(script: string, cwd: string, extra: string[] = []) {
  return spawnSync(
    node,
    [
      script,
      ...extra,
      "--id",
      "t",
      "--attempt",
      "1",
      "--gate-id",
      "g",
      "--intention",
      "i",
      "--definition-of-done",
      "d",
    ],
    { cwd, encoding: "utf8" },
  );
}

function verdictOf(result: { stdout: string; stderr: string }): {
  verdict: string;
  report: string;
} {
  const lines = result.stdout
    .trim()
    .split("\n")
    .filter((line) => line.length > 0);
  const last = lines.at(-1);
  assert.ok(last !== undefined, `stdout: ${result.stdout} stderr: ${result.stderr}`);
  return JSON.parse(last) as { verdict: string; report: string };
}

describe("parent-clean", () => {
  it("refuses when it has no Parent to watch", () => {
    const cwd = sandbox();
    mkdirSync(cwd, { recursive: true });
    const result = verdictOf(run(parentClean, cwd));
    assert.equal(result.verdict, "fail-blocking");
    assert.match(result.report, /--parent/);
  });

  it("passes when the git Parent is unchanged", () => {
    const root = sandbox();
    const parent = join(root, "parent");
    const child = join(root, "child");
    mkdirSync(parent);
    mkdirSync(child);
    gitInit(parent);
    writeFileSync(join(parent, "seed.txt"), "ok\n");
    gitCommit(parent, "seed");
    const result = verdictOf(run(parentClean, child, ["--parent", parent]));
    assert.equal(result.verdict, "pass");
  });

  it("fail-blocking when the git Parent gained a file", () => {
    const root = sandbox();
    const parent = join(root, "parent");
    const child = join(root, "child");
    mkdirSync(parent);
    mkdirSync(child);
    gitInit(parent);
    writeFileSync(join(parent, "seed.txt"), "ok\n");
    gitCommit(parent, "seed");
    writeFileSync(join(parent, "leaked.txt"), "out\n");
    const result = verdictOf(run(parentClean, child, ["--parent", parent]));
    assert.equal(result.verdict, "fail-blocking");
    assert.match(result.report, /leaked\.txt/);
  });

  it("passes when only the Child changed", () => {
    const root = sandbox();
    const parent = join(root, "parent");
    const child = join(root, "child");
    mkdirSync(parent);
    mkdirSync(child);
    gitInit(parent);
    writeFileSync(join(parent, "seed.txt"), "ok\n");
    gitCommit(parent, "seed");
    writeFileSync(join(child, "work.txt"), "in the copy\n");
    const result = verdictOf(run(parentClean, child, ["--parent", parent]));
    assert.equal(result.verdict, "pass");
  });

  it("sees the other worktree without --parent", () => {
    const root = sandbox();
    const parent = join(root, "parent");
    const child = join(root, "child");
    mkdirSync(parent);
    gitInit(parent);
    writeFileSync(join(parent, "seed.txt"), "ok\n");
    gitCommit(parent, "seed");
    execFileSync("git", ["-C", parent, "worktree", "add", "--detach", child]);
    writeFileSync(join(parent, "leaked.txt"), "out\n");
    const result = verdictOf(run(parentClean, child));
    assert.equal(result.verdict, "fail-blocking");
    assert.match(result.report, /leaked\.txt/);
  });

  it("ignores a worktree git still lists after its directory went away", () => {
    const root = sandbox();
    const parent = join(root, "parent");
    const gone = join(root, "gone");
    const child = join(root, "child");
    mkdirSync(parent);
    gitInit(parent);
    writeFileSync(join(parent, "seed.txt"), "ok\n");
    gitCommit(parent, "seed");
    execFileSync("git", ["-C", parent, "worktree", "add", "--detach", gone]);
    execFileSync("git", ["-C", parent, "worktree", "add", "--detach", child]);
    rmSync(gone, { recursive: true, force: true });
    assert.equal(verdictOf(run(parentClean, child)).verdict, "pass");
  });

  it("still fail-blocks on a --parent that is not there", () => {
    const cwd = sandbox();
    const result = verdictOf(run(parentClean, cwd, ["--parent", join(cwd, "nope")]));
    assert.equal(result.verdict, "fail-blocking");
    assert.match(result.report, /not a directory/);
  });

  it("fail-blocking when a copy Parent got a newer file", async () => {
    const root = sandbox();
    const parent = join(root, "parent");
    const child = join(root, "child");
    mkdirSync(parent);
    mkdirSync(child);
    writeFileSync(join(parent, "seed.txt"), "ok\n");
    writeFileSync(join(child, "copy.txt"), "snapshot\n");
    await setTimeout(20);
    writeFileSync(join(parent, "leaked.txt"), "out\n");
    const result = verdictOf(run(parentClean, child, ["--parent", parent]));
    assert.equal(result.verdict, "fail-blocking");
    assert.match(result.report, /leaked\.txt/);
  });
});

describe("ci-green", () => {
  it("refuses without --token-env rather than falling back to GITHUB_TOKEN", () => {
    const cwd = sandbox();
    gitInit(cwd);
    writeFileSync(join(cwd, "a.txt"), "a\n");
    gitCommit(cwd, "seed");
    const result = verdictOf(run(ciGreen, cwd));
    assert.equal(result.verdict, "fail-blocking");
    assert.match(result.report, /--token-env/);
  });

  it("names the variable it was told when that variable is empty", () => {
    const cwd = sandbox();
    gitInit(cwd);
    writeFileSync(join(cwd, "a.txt"), "a\n");
    gitCommit(cwd, "seed");
    execFileSync("git", ["remote", "add", "origin", "git@github.com:tilap/mason.git"], { cwd });
    const result = verdictOf(run(ciGreen, cwd, ["--token-env", "MASON_TEST_TOKEN_UNSET"]));
    assert.equal(result.verdict, "fail-blocking");
    assert.match(result.report, /MASON_TEST_TOKEN_UNSET/);
  });

  /**
   * A GitHub that answers the three reads this Gate makes, for one open pull
   * request on `feature` at sha `abc`. `statuses` is called on every read, so a
   * test can move a status from pending to settled between polls; `undefined`
   * answers 404, as for a token that may not read them.
   */
  async function fakeGitHub(
    checkRuns: unknown[],
    statuses: () => unknown[] | undefined,
  ): Promise<{ base: string; close: () => void }> {
    const server = createServer((request, response) => {
      const path = request.url ?? "";
      let body: unknown;
      if (path.startsWith("/repos/o/r/pulls?")) {
        body = [{ number: 7, head: { sha: "abc" } }];
      } else if (path.startsWith("/repos/o/r/commits/abc/check-runs")) {
        body = { total_count: checkRuns.length, check_runs: checkRuns };
      } else if (path.startsWith("/repos/o/r/commits/abc/status")) {
        const listed = statuses();
        body = listed === undefined ? undefined : { state: "whatever", statuses: listed };
      }
      response.writeHead(body === undefined ? 404 : 200, { "content-type": "application/json" });
      response.end(JSON.stringify(body ?? { message: "Not Found" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address !== null && typeof address === "object");
    return { base: `http://127.0.0.1:${address.port}`, close: () => server.close() };
  }

  function onFeatureBranch(): string {
    const cwd = sandbox();
    gitInit(cwd);
    writeFileSync(join(cwd, "a.txt"), "a\n");
    gitCommit(cwd, "seed");
    execFileSync("git", ["-C", cwd, "checkout", "-q", "-b", "feature"]);
    execFileSync("git", ["-C", cwd, "remote", "add", "origin", "git@github.com:o/r.git"]);
    return cwd;
  }

  /** The Gate, spawned without blocking: the fake GitHub lives in this process. */
  function judge(cwd: string, base: string): Promise<{ verdict: string; report: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        node,
        [
          ciGreen,
          "--token-env",
          "CI_GREEN_TEST_TOKEN",
          "--api-base",
          base,
          "--require-checks",
          "--poll-ms",
          "20",
          "--id",
          "t",
          "--attempt",
          "1",
          "--gate-id",
          "g",
          "--intention",
          "i",
          "--definition-of-done",
          "d",
        ],
        { cwd, env: { ...process.env, CI_GREEN_TEST_TOKEN: "t0ken" } },
      );
      let stdout = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.on("error", reject);
      child.on("close", () => resolve(verdictOf({ stdout, stderr: "" })));
    });
  }

  it("reads a commit status as a check: a repository whose CI is not Actions still has one", {
    timeout: 20_000,
  }, async () => {
    // Seen on a Vercel-only repository: no check run ever, one status. With
    // --require-checks the Gate waited out its whole timeout, on every round.
    const github = await fakeGitHub([], () => [
      { context: "Vercel", state: "success", description: "Deployment has completed" },
    ]);
    try {
      assert.equal((await judge(onFeatureBranch(), github.base)).verdict, "pass");
    } finally {
      github.close();
    }
  });

  it("refuses on a failed status, with what the reporter said and where", {
    timeout: 20_000,
  }, async () => {
    const github = await fakeGitHub([], () => [
      {
        context: "Vercel",
        state: "failure",
        description: "Build failed",
        target_url: "https://vercel.com/tilap/web-emojis/abc",
      },
    ]);
    try {
      const result = await judge(onFeatureBranch(), github.base);
      assert.equal(result.verdict, "fail-retryable");
      assert.equal(
        result.report,
        "Vercel: failure\nBuild failed\nhttps://vercel.com/tilap/web-emojis/abc",
      );
    } finally {
      github.close();
    }
  });

  it("waits on a pending status, and answers once it settles", { timeout: 20_000 }, async () => {
    let reads = 0;
    const github = await fakeGitHub([], () => {
      reads += 1;
      return [{ context: "Vercel", state: reads < 3 ? "pending" : "success" }];
    });
    try {
      assert.equal((await judge(onFeatureBranch(), github.base)).verdict, "pass");
      assert.ok(reads >= 3, `read ${reads} times`);
    } finally {
      github.close();
    }
  });

  it("still judges check runs, and a status it cannot read is no status", {
    timeout: 20_000,
  }, async () => {
    const server = await fakeGitHub(
      [{ id: 1, name: "test", status: "completed", conclusion: "failure" }],
      () => undefined,
    );
    try {
      const result = await judge(onFeatureBranch(), server.base);
      assert.equal(result.verdict, "fail-retryable");
      assert.match(result.report, /^test: failure/);
    } finally {
      server.close();
    }
  });
});

describe("sensitive-path", () => {
  it("refuses without a glob", () => {
    const cwd = sandbox();
    gitInit(cwd);
    writeFileSync(join(cwd, "a.txt"), "a\n");
    gitCommit(cwd, "seed");
    const result = verdictOf(run(sensitivePath, cwd));
    assert.equal(result.verdict, "fail-blocking");
    assert.match(result.report, /glob/);
  });

  it("refuses a workspace that is not git", () => {
    const cwd = sandbox();
    writeFileSync(join(cwd, ".env"), "x\n");
    const result = verdictOf(run(sensitivePath, cwd, ["**/.env"]));
    assert.equal(result.verdict, "fail-blocking");
    assert.match(result.report, /git/);
  });

  it("passes when a matching file is unchanged", () => {
    const cwd = sandbox();
    gitInit(cwd);
    writeFileSync(join(cwd, ".env"), "secret\n");
    writeFileSync(join(cwd, "src.txt"), "ok\n");
    gitCommit(cwd, "seed");
    const result = verdictOf(run(sensitivePath, cwd, ["**/.env"]));
    assert.equal(result.verdict, "pass");
  });

  it("fail-retryable when a matching file is edited", () => {
    const cwd = sandbox();
    gitInit(cwd);
    writeFileSync(join(cwd, ".env"), "secret\n");
    gitCommit(cwd, "seed");
    writeFileSync(join(cwd, ".env"), "changed\n");
    const result = verdictOf(run(sensitivePath, cwd, ["**/.env"]));
    assert.equal(result.verdict, "fail-retryable");
    assert.match(result.report, /\.env/);
  });

  it("passes when only a non-matching file changed", () => {
    const cwd = sandbox();
    gitInit(cwd);
    writeFileSync(join(cwd, ".env"), "secret\n");
    writeFileSync(join(cwd, "src.txt"), "ok\n");
    gitCommit(cwd, "seed");
    writeFileSync(join(cwd, "src.txt"), "edited\n");
    const result = verdictOf(run(sensitivePath, cwd, ["**/.env"]));
    assert.equal(result.verdict, "pass");
  });

  it("fail-retryable when a matching file is new", () => {
    const cwd = sandbox();
    gitInit(cwd);
    writeFileSync(join(cwd, "src.txt"), "ok\n");
    gitCommit(cwd, "seed");
    writeFileSync(join(cwd, ".env"), "secret\n");
    const result = verdictOf(run(sensitivePath, cwd, ["**/.env"]));
    assert.equal(result.verdict, "fail-retryable");
    assert.match(result.report, /\.env/);
  });

  it("fail-retryable when a matching file is deleted", () => {
    const cwd = sandbox();
    gitInit(cwd);
    writeFileSync(join(cwd, ".env"), "secret\n");
    gitCommit(cwd, "seed");
    unlinkSync(join(cwd, ".env"));
    const result = verdictOf(run(sensitivePath, cwd, ["**/.env"]));
    assert.equal(result.verdict, "fail-retryable");
    assert.match(result.report, /\.env/);
  });
});

describe("workspace-changed", () => {
  it("refuses a workspace that is not git", () => {
    const cwd = sandbox();
    writeFileSync(join(cwd, "work.txt"), "done\n");
    const result = verdictOf(run(workspaceChanged, cwd));
    assert.equal(result.verdict, "fail-blocking");
    assert.match(result.report, /git/);
  });

  it("refuses an option", () => {
    const cwd = sandbox();
    gitInit(cwd);
    const result = verdictOf(run(workspaceChanged, cwd, ["--since", "HEAD"]));
    assert.equal(result.verdict, "fail-blocking");
    assert.match(result.report, /--since/);
  });

  it("fail-retryable when the Attempt changed nothing", () => {
    const cwd = sandbox();
    gitInit(cwd);
    writeFileSync(join(cwd, "seed.txt"), "ok\n");
    gitCommit(cwd, "seed");
    const result = verdictOf(run(workspaceChanged, cwd));
    assert.equal(result.verdict, "fail-retryable");
    assert.match(result.report, /produced nothing/);
  });

  it("says nothing about an assembly that needed no change", () => {
    const cwd = sandbox();
    gitInit(cwd);
    writeFileSync(join(cwd, "seed.txt"), "ok\n");
    gitCommit(cwd, "seed");
    // Refusing here does not send a producer back to work — it sends it back to
    // find something to change, and it obliges.
    assert.equal(verdictOf(run(workspaceChanged, cwd, ["--stage", "assembly"])).verdict, "pass");
    assert.equal(
      verdictOf(run(workspaceChanged, cwd, ["--stage", "unit"])).verdict,
      "fail-retryable",
    );
  });

  it("passes on a new file", () => {
    const cwd = sandbox();
    gitInit(cwd);
    writeFileSync(join(cwd, "seed.txt"), "ok\n");
    gitCommit(cwd, "seed");
    writeFileSync(join(cwd, "work.txt"), "done\n");
    assert.equal(verdictOf(run(workspaceChanged, cwd)).verdict, "pass");
  });

  it("passes on an edited file", () => {
    const cwd = sandbox();
    gitInit(cwd);
    writeFileSync(join(cwd, "seed.txt"), "ok\n");
    gitCommit(cwd, "seed");
    writeFileSync(join(cwd, "seed.txt"), "edited\n");
    assert.equal(verdictOf(run(workspaceChanged, cwd)).verdict, "pass");
  });

  it("fail-retryable when the Attempt committed its work", () => {
    const cwd = sandbox();
    gitInit(cwd);
    writeFileSync(join(cwd, "seed.txt"), "ok\n");
    gitCommit(cwd, "seed");
    writeFileSync(join(cwd, "work.txt"), "done\n");
    gitCommit(cwd, "work");
    const result = verdictOf(run(workspaceChanged, cwd));
    assert.equal(result.verdict, "fail-retryable");
    assert.match(result.report, /do not commit/i);
  });
});
