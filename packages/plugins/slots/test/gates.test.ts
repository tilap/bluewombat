import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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
const testsOnly = join(gates, "tests-only.mjs");
const workspaceChanged = join(gates, "workspace-changed.mjs");
const ciGreen = join(gates, "ci-green.mjs");
const gitignoreLeak = join(gates, "gitignore-leak.mjs");
const projectChecks = join(gates, "project-checks.mjs");
const workspaceUnchanged = join(gates, "workspace-unchanged.mjs");
const testsRed = join(gates, "tests-red.mjs");
const testsFrozen = join(gates, "tests-frozen.mjs");

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
    [script, ...extra, "--id", "t", "--attempt", "1", "--gate-id", "g", "--intention", "i"],
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
   * request on `ticket` at sha `abc`. `statuses` is called on every read, so a
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
        body = [{ number: 7, head: { sha: "abc" }, base: { ref: "dev" } }];
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

  function onTicketBranch(): string {
    const cwd = sandbox();
    gitInit(cwd);
    writeFileSync(join(cwd, "a.txt"), "a\n");
    gitCommit(cwd, "seed");
    execFileSync("git", ["-C", cwd, "checkout", "-q", "-b", "ticket"]);
    execFileSync("git", ["-C", cwd, "remote", "add", "origin", "git@github.com:o/r.git"]);
    return cwd;
  }

  /** The Gate, spawned without blocking: the fake GitHub lives in this process. */
  function judge(
    cwd: string,
    base: string,
    extra: string[] = [],
  ): Promise<{ verdict: string; report: string }> {
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
          ...extra,
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
      assert.equal((await judge(onTicketBranch(), github.base)).verdict, "pass");
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
      const result = await judge(onTicketBranch(), github.base);
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
      assert.equal((await judge(onTicketBranch(), github.base)).verdict, "pass");
      assert.ok(reads >= 3, `read ${reads} times`);
    } finally {
      github.close();
    }
  });

  it("stops waiting for a check that never appears, and blocks instead of refusing", {
    timeout: 20_000,
  }, async () => {
    // Seen when Vercel deployed fifty minutes late: no check at all, and the Gate
    // waited to be killed. A kill reads as a refusal and sends the work to an agent
    // with nothing to fix. With the ceiling it was given, it says so itself.
    const github = await fakeGitHub([], () => []);
    try {
      // Nothing here kills it: if it did not stop on its own, this test would wait out
      // its own 20 s timeout instead.
      const result = await judge(onTicketBranch(), github.base, ["--timeout-ms", "3000"]);
      assert.equal(result.verdict, "fail-blocking");
      assert.match(result.report, /stopped waiting after \d+ s: no check has appeared on abc/);
      assert.match(result.report, /pull request #7/);
      assert.match(result.report, /not a refusal of the work/);
      // The three causes, so nobody has to guess which one this is.
      assert.match(result.report, /has no CI \(then take ci-green out/);
      assert.match(result.report, /do not run on pull requests into "dev"/);
    } finally {
      github.close();
    }
  });

  it("stops waiting for checks that never finish, and says how many", {
    timeout: 20_000,
  }, async () => {
    const github = await fakeGitHub([{ id: 1, name: "test", status: "in_progress" }], () => [
      { context: "Vercel", state: "pending" },
    ]);
    try {
      const result = await judge(onTicketBranch(), github.base, ["--timeout-ms", "3000"]);
      assert.equal(result.verdict, "fail-blocking");
      assert.match(result.report, /2 checks were still running on abc/);
    } finally {
      github.close();
    }
  });

  it("still refuses a failed check when it has a ceiling: that one has a reason", {
    timeout: 20_000,
  }, async () => {
    const github = await fakeGitHub([], () => [
      { context: "Vercel", state: "failure", description: "Build failed" },
    ]);
    try {
      const result = await judge(onTicketBranch(), github.base, ["--timeout-ms", "3000"]);
      assert.equal(result.verdict, "fail-retryable");
      assert.match(result.report, /^Vercel: failure\nBuild failed/);
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
      const result = await judge(onTicketBranch(), server.base);
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

  it("passes on what an install left under an ignored directory", () => {
    // Seen live: node_modules/iconv-lite/.github/dependabot.yml refused two of
    // three Attempts that touched nothing sensitive.
    const cwd = sandbox();
    gitInit(cwd);
    writeFileSync(join(cwd, ".gitignore"), "node_modules/\n");
    writeFileSync(join(cwd, "src.txt"), "ok\n");
    gitCommit(cwd, "seed");
    mkdirSync(join(cwd, "node_modules", "iconv-lite", ".github"), { recursive: true });
    writeFileSync(join(cwd, "node_modules", "iconv-lite", ".github", "dependabot.yml"), "x\n");
    const result = verdictOf(run(sensitivePath, cwd, ["**/.github/**"]));
    assert.equal(result.verdict, "pass");
  });

  it("still sees a tracked path under an ignored directory", () => {
    const cwd = sandbox();
    gitInit(cwd);
    writeFileSync(join(cwd, ".gitignore"), "vendor/\n");
    mkdirSync(join(cwd, "vendor", ".github"), { recursive: true });
    writeFileSync(join(cwd, "vendor", ".github", "ci.yml"), "one\n");
    execFileSync("git", ["-C", cwd, "add", "-A", "-f"]);
    execFileSync("git", ["-C", cwd, "commit", "-qm", "seed"]);
    writeFileSync(join(cwd, "vendor", ".github", "ci.yml"), "two\n");
    const result = verdictOf(run(sensitivePath, cwd, ["**/.github/**"]));
    assert.equal(result.verdict, "fail-retryable");
    assert.match(result.report, /vendor\/\.github\/ci\.yml/);
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

describe("gitignore-leak", () => {
  const assembly = (...own: string[]) => [...own, "--stage", "ticket"];

  /** A work line on `main` that ignores node_modules/ and dist/, and a ticket branch off it. */
  function ticketOff(baseFiles: Record<string, string> = {}): string {
    const cwd = sandbox();
    gitInit(cwd);
    writeFileSync(join(cwd, ".gitignore"), "node_modules/\ndist/\n");
    writeFileSync(join(cwd, "src.txt"), "ok\n");
    for (const [path, content] of Object.entries(baseFiles)) {
      mkdirSync(dirname(join(cwd, path)), { recursive: true });
      writeFileSync(join(cwd, path), content);
    }
    execFileSync("git", ["-C", cwd, "add", "-A", "-f"]);
    execFileSync("git", ["-C", cwd, "commit", "-qm", "work line"]);
    execFileSync("git", ["-C", cwd, "checkout", "-q", "-b", "ticket"]);
    return cwd;
  }

  /** What the leak looked like for real: a fold that force-added a Builder's install. */
  function commitVendored(cwd: string): void {
    mkdirSync(join(cwd, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(cwd, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
    writeFileSync(join(cwd, "src.txt"), "ticket\n");
    execFileSync("git", ["-C", cwd, "add", "-A", "-f"]);
    execFileSync("git", ["-C", cwd, "commit", "-qm", "ticket, with its install"]);
  }

  it("refuses a workspace that is not git", () => {
    const cwd = sandbox();
    writeFileSync(join(cwd, "a.txt"), "a\n");
    const result = verdictOf(run(gitignoreLeak, cwd, assembly("--base", "main")));
    assert.equal(result.verdict, "fail-blocking");
    assert.match(result.report, /git/);
  });

  it("refuses an option it does not read", () => {
    const cwd = ticketOff();
    const result = verdictOf(run(gitignoreLeak, cwd, assembly("--since", "HEAD")));
    assert.equal(result.verdict, "fail-blocking");
    assert.match(result.report, /--since/);
  });

  it("refuses to judge without the work line it is measured against", () => {
    const cwd = ticketOff();
    const missing = verdictOf(run(gitignoreLeak, cwd, assembly()));
    assert.equal(missing.verdict, "fail-blocking");
    assert.match(missing.report, /--base/);
    const unknown = verdictOf(run(gitignoreLeak, cwd, assembly("--base", "nowhere")));
    assert.equal(unknown.verdict, "fail-blocking");
    assert.match(unknown.report, /cannot find --base "nowhere"/);
  });

  it("says nothing about a unit, whose work no commit holds yet", () => {
    const cwd = ticketOff();
    commitVendored(cwd);
    assert.equal(verdictOf(run(gitignoreLeak, cwd, ["--base", "main"])).verdict, "pass");
    assert.equal(
      verdictOf(run(gitignoreLeak, cwd, ["--base", "main", "--stage", "unit"])).verdict,
      "pass",
    );
  });

  it("passes a ticket that adds only what .gitignore lets in", () => {
    const cwd = ticketOff();
    writeFileSync(join(cwd, "added.txt"), "new\n");
    mkdirSync(join(cwd, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(cwd, "node_modules", "left-pad", "index.js"), "on disk only\n");
    gitCommit(cwd, "ticket");
    assert.equal(verdictOf(run(gitignoreLeak, cwd, assembly("--base", "main"))).verdict, "pass");
  });

  it("does not blame a ticket for a path the work line tracked on purpose", () => {
    const cwd = ticketOff({ "dist/.gitkeep": "" });
    writeFileSync(join(cwd, "src.txt"), "ticket\n");
    gitCommit(cwd, "ticket");
    assert.equal(verdictOf(run(gitignoreLeak, cwd, assembly("--base", "main"))).verdict, "pass");
  });

  it("fail-retryable when the ticket's commits add an ignored path", () => {
    const cwd = ticketOff();
    commitVendored(cwd);
    const result = verdictOf(run(gitignoreLeak, cwd, assembly("--base", "main")));
    assert.equal(result.verdict, "fail-retryable");
    assert.match(result.report, /^node_modules\/left-pad\/index\.js$/m);
    assert.match(result.report, /git rm -r --cached/);
    assert.doesNotMatch(result.report, /src\.txt/);
  });

  it("judges what is committed, not a removal only staged", () => {
    const cwd = ticketOff();
    commitVendored(cwd);
    execFileSync("git", ["-C", cwd, "rm", "-r", "-q", "--cached", "node_modules"]);
    const result = verdictOf(run(gitignoreLeak, cwd, assembly("--base", "main")));
    assert.equal(result.verdict, "fail-retryable");
  });

  it("passes once a later commit took the path out again", () => {
    const cwd = ticketOff();
    commitVendored(cwd);
    execFileSync("git", ["-C", cwd, "rm", "-r", "-q", "--cached", "node_modules"]);
    execFileSync("git", ["-C", cwd, "commit", "-qm", "untrack node_modules"]);
    assert.equal(verdictOf(run(gitignoreLeak, cwd, assembly("--base", "main"))).verdict, "pass");
  });

  it("sees a tracked file moved under an ignored directory", () => {
    const cwd = ticketOff({ "lib/out.js": "built\n" });
    mkdirSync(join(cwd, "dist"), { recursive: true });
    execFileSync("git", ["-C", cwd, "mv", "-f", "lib/out.js", "dist/out.js"]);
    execFileSync("git", ["-C", cwd, "commit", "-qm", "move the build output"]);
    const result = verdictOf(run(gitignoreLeak, cwd, assembly("--base", "main")));
    assert.equal(result.verdict, "fail-retryable");
    assert.match(result.report, /^dist\/out\.js$/m);
  });

  it("lists fifty paths and counts the rest", () => {
    const cwd = ticketOff();
    mkdirSync(join(cwd, "dist"), { recursive: true });
    for (let i = 0; i < 55; i++) {
      writeFileSync(join(cwd, "dist", `f${String(i).padStart(2, "0")}.js`), `${i}\n`);
    }
    execFileSync("git", ["-C", cwd, "add", "-A", "-f"]);
    execFileSync("git", ["-C", cwd, "commit", "-qm", "build output"]);
    const result = verdictOf(run(gitignoreLeak, cwd, assembly("--base", "main")));
    assert.equal(result.verdict, "fail-retryable");
    assert.equal((result.report.match(/^dist\//gm) ?? []).length, 50);
    assert.match(result.report, /… and 5 more$/);
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

  it("says nothing about a ticket that needed no change", () => {
    const cwd = sandbox();
    gitInit(cwd);
    writeFileSync(join(cwd, "seed.txt"), "ok\n");
    gitCommit(cwd, "seed");
    // Refusing here does not send a producer back to work — it sends it back to
    // find something to change, and it obliges.
    assert.equal(verdictOf(run(workspaceChanged, cwd, ["--stage", "ticket"])).verdict, "pass");
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

describe("project-checks", () => {
  it("refuses to run without a command", () => {
    const result = verdictOf(run(projectChecks, sandbox()));
    assert.equal(result.verdict, "fail-blocking");
    assert.match(result.report, /--cmd/);
  });

  it("refuses an option it does not know", () => {
    const result = verdictOf(run(projectChecks, sandbox(), ["--cmd", "true", "--bogus", "x"]));
    assert.equal(result.verdict, "fail-blocking");
    assert.match(result.report, /--bogus/);
  });

  it("passes when the command exits 0", () => {
    const result = verdictOf(run(projectChecks, sandbox(), ["--cmd", "true"]));
    assert.equal(result.verdict, "pass");
  });

  it("runs the command in the workspace", () => {
    const cwd = sandbox();
    writeFileSync(join(cwd, "marker.txt"), "here\n");
    const result = verdictOf(run(projectChecks, cwd, ["--cmd", "test -f marker.txt"]));
    assert.equal(result.verdict, "pass");
  });

  it("fail-retryable on a red check, with the end of its output", () => {
    const result = verdictOf(
      run(projectChecks, sandbox(), [
        "--cmd",
        "echo first; echo 'TS2322: not assignable' >&2; exit 2",
      ]),
    );
    assert.equal(result.verdict, "fail-retryable");
    assert.match(result.report, /exit 2/);
    assert.match(result.report, /TS2322: not assignable/);
  });

  it("keeps the end of a long output, not the start", () => {
    const result = verdictOf(
      run(projectChecks, sandbox(), ["--cmd", "seq 1 20000; echo THE-REAL-ERROR; exit 1"]),
    );
    assert.equal(result.verdict, "fail-retryable");
    assert.match(result.report, /THE-REAL-ERROR/);
    assert.doesNotMatch(result.report, /^1$/m);
    assert.ok(result.report.length < 20_000);
  });

  it("keeps the error when a spinner redraws thousands of lines after it", () => {
    // What drizzle-kit does under turbo: the error is followed by progress lines from other packages.
    const spinner = String.raw`printf 'web:test: \033[2K\033[1G[\342\243\267] Pulling schema from database...\n'`;
    const done = String.raw`printf 'auth:test: [\342\234\223] Pulling schema from database...\n'`;
    const result = verdictOf(
      run(projectChecks, sandbox(), [
        "--cmd",
        `echo 'Error: Test timed out in 30000ms.'; i=0; while [ $i -lt 3000 ]; do ${spinner}; ${done}; i=$((i+1)); done; exit 1`,
      ]),
    );
    assert.equal(result.verdict, "fail-retryable");
    const output = result.report.split("End of its output:")[1] ?? "";
    assert.match(output, /Test timed out in 30000ms/);
    assert.doesNotMatch(output, /Pulling schema/);
  });

  it("reduces a line redrawn with a carriage return to its last state", () => {
    const result = verdictOf(
      run(projectChecks, sandbox(), [
        "--cmd",
        String.raw`printf 'step 1\rstep 2\r\033[2Kdone 3\n'; exit 1`,
      ]),
    );
    const output = result.report.split("End of its output:")[1] ?? "";
    assert.match(output, /done 3/);
    assert.doesNotMatch(output, /step 1|step 2/);
  });

  it("fail-blocking when the command does not exist: no change to the work fixes it", () => {
    const result = verdictOf(
      run(projectChecks, sandbox(), ["--cmd", "no-such-tool-xyz --version"]),
    );
    assert.equal(result.verdict, "fail-blocking");
    assert.match(result.report, /could not be run/);
  });

  it("fail-blocking when the command outlives the ceiling, and stops it", () => {
    const cwd = sandbox();
    const started = Date.now();
    const result = verdictOf(
      run(projectChecks, cwd, ["--cmd", "echo started; sleep 30", "--timeout-ms", "1500"]),
    );
    assert.equal(result.verdict, "fail-blocking");
    assert.match(result.report, /did not finish/);
    assert.match(result.report, /started/);
    assert.ok(Date.now() - started < 15_000, "the command was not stopped");
  });

  it("judges the same way for a ticket", () => {
    const red = verdictOf(run(projectChecks, sandbox(), ["--cmd", "exit 1", "--stage", "ticket"]));
    assert.equal(red.verdict, "fail-retryable");
    const green = verdictOf(run(projectChecks, sandbox(), ["--cmd", "true", "--stage", "ticket"]));
    assert.equal(green.verdict, "pass");
  });
});

describe("workspace-unchanged", () => {
  function committed(): string {
    const cwd = sandbox();
    gitInit(cwd);
    writeFileSync(join(cwd, "a.txt"), "a\n");
    writeFileSync(join(cwd, ".gitignore"), "ignored.log\n");
    gitCommit(cwd, "seed");
    return cwd;
  }

  it("passes on a workspace where everything is committed", () => {
    assert.equal(verdictOf(run(workspaceUnchanged, committed())).verdict, "pass");
  });

  it("blocks on a modified file, and names it", () => {
    const cwd = committed();
    writeFileSync(join(cwd, "a.txt"), "changed\n");
    const result = verdictOf(run(workspaceUnchanged, cwd));
    assert.equal(result.verdict, "fail-blocking");
    assert.match(result.report, /a\.txt/);
    assert.match(result.report, /read-only/);
  });

  it("blocks on a new file, and on a deleted one", () => {
    const added = committed();
    writeFileSync(join(added, "new.txt"), "x\n");
    const one = verdictOf(run(workspaceUnchanged, added));
    assert.equal(one.verdict, "fail-blocking");
    assert.match(one.report, /new\.txt/);

    const removed = committed();
    unlinkSync(join(removed, "a.txt"));
    const two = verdictOf(run(workspaceUnchanged, removed));
    assert.equal(two.verdict, "fail-blocking");
    assert.match(two.report, /a\.txt/);
  });

  it("does not see what .gitignore excludes", () => {
    const cwd = committed();
    writeFileSync(join(cwd, "ignored.log"), "noise\n");
    assert.equal(verdictOf(run(workspaceUnchanged, cwd)).verdict, "pass");
  });

  it("lets a path through when it is named with --allow", () => {
    const cwd = committed();
    mkdirSync(join(cwd, "coverage"));
    writeFileSync(join(cwd, "coverage", "lcov.info"), "x\n");
    writeFileSync(join(cwd, "a.txt"), "changed\n");
    const result = verdictOf(run(workspaceUnchanged, cwd, ["--allow", "coverage/**"]));
    assert.equal(result.verdict, "fail-blocking");
    assert.match(result.report, /a\.txt/);
    assert.doesNotMatch(result.report, /lcov/);

    unlinkSync(join(cwd, "a.txt"));
    execFileSync("git", ["-C", cwd, "checkout", "--", "a.txt"]);
    assert.equal(
      verdictOf(run(workspaceUnchanged, cwd, ["--allow", "coverage/**"])).verdict,
      "pass",
    );
  });

  it("refuses an option it does not know, and a directory that is not git", () => {
    assert.equal(
      verdictOf(run(workspaceUnchanged, committed(), ["--bogus"])).verdict,
      "fail-blocking",
    );
    const plain = sandbox();
    assert.match(verdictOf(run(workspaceUnchanged, plain)).report, /git workspace/);
  });
});

describe("tests-red", () => {
  function repoWithTest(): string {
    const dir = sandbox();
    gitInit(dir);
    writeFileSync(join(dir, "code.txt"), "base\n");
    gitCommit(dir, "init");
    writeFileSync(join(dir, "a.test.ts"), "test\n");
    return dir;
  }

  it("passes when the new tests fail on what they check", () => {
    const dir = repoWithTest();
    const result = verdictOf(
      run(testsRed, dir, ["--cmd", "echo 'AssertionError: expected 1 to be 2'; exit 1"]),
    );
    assert.equal(result.verdict, "pass");
  });

  it("refuses tests that pass before the behaviour exists", () => {
    const dir = repoWithTest();
    const result = verdictOf(run(testsRed, dir, ["--cmd", "exit 0"]));
    assert.equal(result.verdict, "fail-retryable");
    assert.match(result.report ?? "", /test nothing that is missing/);
  });

  it("refuses tests that fail for a wrong reason, and says which", () => {
    const dir = repoWithTest();
    const result = verdictOf(
      run(testsRed, dir, ["--cmd", "echo \"Error: Cannot find module './slugify'\"; exit 1"]),
    );
    assert.equal(result.verdict, "fail-retryable");
    assert.match(result.report ?? "", /not on the missing behaviour: .*Cannot find module/);
  });

  it("takes the wrong reasons the Project names, in place of the defaults", () => {
    const dir = repoWithTest();
    const named = run(testsRed, dir, [
      "--cmd",
      "echo 'boom: setup failed'; exit 1",
      "--not-red-when",
      "setup failed",
    ]);
    assert.equal(verdictOf(named).verdict, "fail-retryable");
    const defaults = run(testsRed, dir, [
      "--cmd",
      "echo \"Cannot find module 'x'\"; exit 1",
      "--not-red-when",
      "setup failed",
    ]);
    assert.equal(verdictOf(defaults).verdict, "pass");
  });

  it("asks for a test file when the pass wrote none", () => {
    const dir = sandbox();
    gitInit(dir);
    writeFileSync(join(dir, "code.txt"), "base\n");
    gitCommit(dir, "init");
    writeFileSync(join(dir, "code.txt"), "changed\n");
    const result = verdictOf(run(testsRed, dir, ["--cmd", "exit 1"]));
    assert.equal(result.verdict, "fail-retryable");
    assert.match(result.report ?? "", /No test file was added or changed/);
  });

  it("runs the command on the test files of the pass only, where {files} says", () => {
    const dir = repoWithTest();
    writeFileSync(join(dir, "other.test.ts"), "more\n");
    const seen = join(dir, "seen.txt");
    const result = verdictOf(
      run(testsRed, dir, ["--cmd", `echo {files} > '${seen}'; echo 'AssertionError'; exit 1`]),
    );
    assert.equal(result.verdict, "pass");
    const said = readFileSync(seen, "utf8");
    assert.match(said, /a\.test\.ts/);
    assert.match(said, /other\.test\.ts/);
    assert.doesNotMatch(said, /code\.txt/);
  });

  it("is blocking when the command cannot run", () => {
    const dir = repoWithTest();
    const result = verdictOf(run(testsRed, dir, ["--cmd", "no-such-command-anywhere"]));
    assert.equal(result.verdict, "fail-blocking");
  });
});

describe("tests-frozen", () => {
  function checkpoint(subject = "Tests: add slugify"): string {
    const dir = sandbox();
    gitInit(dir);
    writeFileSync(join(dir, "code.txt"), "base\n");
    gitCommit(dir, "init");
    writeFileSync(join(dir, "a.test.ts"), "test\n");
    gitCommit(dir, subject);
    return dir;
  }

  it("passes when the tests of the checkpoint are as they were left", () => {
    const dir = checkpoint();
    writeFileSync(join(dir, "code.txt"), "the producer's work\n");
    assert.equal(verdictOf(run(testsFrozen, dir)).verdict, "pass");
  });

  it("refuses a test file that was modified, deleted, or both", () => {
    const edited = checkpoint();
    writeFileSync(join(edited, "a.test.ts"), "edited until it passes\n");
    const editedVerdict = verdictOf(run(testsFrozen, edited));
    assert.equal(editedVerdict.verdict, "fail-retryable");
    assert.match(editedVerdict.report ?? "", /a\.test\.ts/);
    assert.match(editedVerdict.report ?? "", /not yours to change/);

    const removed = checkpoint();
    unlinkSync(join(removed, "a.test.ts"));
    assert.equal(verdictOf(run(testsFrozen, removed)).verdict, "fail-retryable");
  });

  it("allows a new test file beside the frozen ones", () => {
    const dir = checkpoint();
    writeFileSync(join(dir, "b.test.ts"), "the producer adds a test\n");
    assert.equal(verdictOf(run(testsFrozen, dir)).verdict, "pass");
  });

  it("freezes nothing when HEAD is not a checkpoint of the tests pass", () => {
    const dir = checkpoint("Add slugify");
    writeFileSync(join(dir, "a.test.ts"), "edited\n");
    assert.equal(verdictOf(run(testsFrozen, dir)).verdict, "pass");
  });

  it("takes the test globs and the subject prefix the Project names", () => {
    const dir = checkpoint("Specs: add slugify");
    writeFileSync(join(dir, "a.test.ts"), "edited\n");
    const unknown = run(testsFrozen, dir, [
      "--subject-prefix",
      "Specs: ",
      "--test-glob",
      "**/*.nope",
    ]);
    assert.equal(verdictOf(unknown).verdict, "pass");
    const named = run(testsFrozen, dir, ["--subject-prefix", "Specs: "]);
    assert.equal(verdictOf(named).verdict, "fail-retryable");
  });
});

describe("tests-only", () => {
  function repo(): string {
    const cwd = sandbox();
    gitInit(cwd);
    mkdirSync(join(cwd, "src"));
    writeFileSync(join(cwd, "src", "app.ts"), "export const a = 1;\n");
    writeFileSync(join(cwd, "src", "app.test.ts"), "// test\n");
    gitCommit(cwd, "seed");
    return cwd;
  }
  const globs = ["**/*.test.ts", "feature-tests/**"];

  it("passes when only tests and the manifest changed, new or modified", () => {
    const cwd = repo();
    writeFileSync(join(cwd, "src", "app.test.ts"), "// changed\n");
    writeFileSync(join(cwd, "src", "other.test.ts"), "// new\n");
    mkdirSync(join(cwd, "feature-tests"));
    writeFileSync(join(cwd, "feature-tests", "scenarios.json"), '["S1"]');
    assert.equal(verdictOf(run(testsOnly, cwd, globs)).verdict, "pass");
  });

  it("passes when nothing changed", () => {
    assert.equal(verdictOf(run(testsOnly, repo(), globs)).verdict, "pass");
  });

  it("refuses a modified, a new and a deleted application file, and names them", () => {
    const cwd = repo();
    writeFileSync(join(cwd, "src", "app.ts"), "export const a = 2;\n");
    writeFileSync(join(cwd, "src", "new.ts"), "x\n");
    unlinkSync(join(cwd, "src", "app.test.ts"));
    const result = verdictOf(run(testsOnly, cwd, ["feature-tests/**"]));
    assert.equal(result.verdict, "fail-retryable");
    assert.match(result.report, /src\/app\.ts/);
    assert.match(result.report, /src\/new\.ts/);
    assert.match(result.report, /src\/app\.test\.ts/);
  });

  it("sees both ends of a rename", () => {
    const cwd = repo();
    execFileSync("git", ["-C", cwd, "mv", "src/app.ts", "src/test-looking.test.ts"]);
    const result = verdictOf(run(testsOnly, cwd, globs));
    assert.equal(result.verdict, "fail-retryable");
    assert.match(result.report, /src\/app\.ts/);
  });

  it("ignores what .gitignore excludes", () => {
    const cwd = repo();
    writeFileSync(join(cwd, ".gitignore"), "dist/\n");
    gitCommit(cwd, "ignore");
    mkdirSync(join(cwd, "dist"));
    writeFileSync(join(cwd, "dist", "out.js"), "x");
    assert.equal(verdictOf(run(testsOnly, cwd, globs)).verdict, "pass");
  });

  it("is blocking without a glob or outside a git workspace", () => {
    assert.equal(verdictOf(run(testsOnly, repo())).verdict, "fail-blocking");
    assert.equal(verdictOf(run(testsOnly, sandbox(), globs)).verdict, "fail-blocking");
  });
});
