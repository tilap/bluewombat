import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { gitReference } from "./reference.js";
import { clearRunEnv, runEnv } from "./run-env.js";

function sandbox(): string {
  return mkdtempSync(join(tmpdir(), "isolation-git-reference-"));
}

/** A bare remote with one commit on `main`, the shape a hosted repository has. */
function remoteWith(branch = "main"): { remote: string; root: string } {
  const root = sandbox();
  const seed = join(root, "seed");
  mkdirSync(seed);
  writeFileSync(join(seed, "a.txt"), "hello");
  execFileSync("git", ["init", "-b", branch], { cwd: seed });
  execFileSync("git", ["config", "user.email", "reference@test.local"], { cwd: seed });
  execFileSync("git", ["config", "user.name", "Reference Test"], { cwd: seed });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: seed });
  execFileSync("git", ["add", "."], { cwd: seed });
  execFileSync("git", ["commit", "-m", "init"], { cwd: seed });
  const remote = join(root, "remote.git");
  execFileSync("git", ["clone", "--bare", seed, remote]);
  return { remote, root };
}

function parsedOrFail(raw: Record<string, unknown>) {
  const result = gitReference.parse(raw);
  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  if (!result.ok) {
    throw new Error("unreachable");
  }
  return result;
}

describe("gitReference.parse", () => {
  it("refuses an unknown key, naming the expected ones", () => {
    const result = gitReference.parse({ remot: "x", branch: "main" });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /unknown key "remot"/);
      assert.match(result.reason, /remote, branch/);
    }
  });

  it("refuses a missing key", () => {
    const result = gitReference.parse({ remote: "x" });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /missing "branch"/);
    }
  });

  it("refuses a wrong type and an empty string", () => {
    const typed = gitReference.parse({ remote: 3, branch: "main" });
    assert.equal(typed.ok, false);
    const empty = gitReference.parse({ remote: "x", branch: "  " });
    assert.equal(empty.ok, false);
  });

  it("names the branch as the target and both in the summary", () => {
    const reference = parsedOrFail({ remote: "git@example.com:o/n.git", branch: "develop" });
    assert.equal(reference.target, "develop");
    assert.equal(reference.summary, "git@example.com:o/n.git (develop)");
  });
});

describe("gitReference identity and credentials", () => {
  it("reads author and credentialEnv into the git environment of the run", () => {
    const parsed = parsedOrFail({
      remote: "https://example.test/acme/app.git",
      branch: "main",
      credentialEnv: "APP_TOKEN",
      author: { name: "mason", email: "mason@example.test" },
    });
    assert.equal(parsed.env.GIT_AUTHOR_NAME, "mason");
    assert.equal(parsed.env.GIT_AUTHOR_EMAIL, "mason@example.test");
    assert.equal(parsed.env.GIT_COMMITTER_NAME, "mason");
    assert.equal(parsed.env.GIT_CONFIG_KEY_1, "credential.helper");
    // The helper reads the token when git asks; the token itself is not in the env we hand out.
    assert.match(parsed.env.GIT_CONFIG_VALUE_1 ?? "", /\$\{APP_TOKEN\}/);
    assert.equal(parsed.env.GIT_TERMINAL_PROMPT, "0");
    assert.deepEqual(runEnv(), parsed.env, "the package's own git calls carry the same");
    clearRunEnv();
  });

  it("leaves the environment empty when the manager names neither", () => {
    const parsed = parsedOrFail({ remote: "git@example.test:acme/app.git", branch: "main" });
    assert.deepEqual(parsed.env, {});
  });

  it("refuses a malformed author or an empty credentialEnv", () => {
    for (const raw of [
      { remote: "r", branch: "b", author: "mason" },
      { remote: "r", branch: "b", author: { name: "mason" } },
      { remote: "r", branch: "b", author: { name: " ", email: "x" } },
      { remote: "r", branch: "b", credentialEnv: "" },
    ]) {
      const result = gitReference.parse(raw);
      assert.equal(result.ok, false, JSON.stringify(raw));
    }
  });
});

describe("gitReference copy", () => {
  it("reports a missing copy, then materializes it and matches", async () => {
    const { remote, root } = remoteWith();
    const reference = parsedOrFail({ remote, branch: "main" });
    const copy = join(root, ".mason", "work-line");

    assert.deepEqual(reference.inspect(copy), { kind: "missing" });
    const made = await reference.materialize(copy);
    assert.equal(made.ok, true, made.ok ? "" : made.reason);
    assert.equal(existsSync(join(copy, ".git")), true);
    assert.deepEqual(reference.inspect(copy), { kind: "matches" });
  });

  it("refuses to materialize a branch the remote does not have, listing the others", async () => {
    const { remote, root } = remoteWith();
    const reference = parsedOrFail({ remote, branch: "develop" });
    const made = await reference.materialize(join(root, "copy"));
    assert.equal(made.ok, false);
    if (!made.ok) {
      assert.match(made.reason, /no branch "develop"/);
      assert.match(made.reason, /main/);
    }
  });

  it("reports a directory that is not a git tree as a mismatch", () => {
    const { remote, root } = remoteWith();
    const reference = parsedOrFail({ remote, branch: "main" });
    const plain = join(root, "plain");
    mkdirSync(plain);
    const state = reference.inspect(plain);
    assert.equal(state.kind, "mismatch");
  });

  it("reports a copy of another remote as a mismatch", async () => {
    const first = remoteWith();
    const second = remoteWith();
    const copy = join(first.root, "copy");
    const made = await parsedOrFail({ remote: first.remote, branch: "main" }).materialize(copy);
    assert.equal(made.ok, true);
    const state = parsedOrFail({ remote: second.remote, branch: "main" }).inspect(copy);
    assert.equal(state.kind, "mismatch");
    if (state.kind === "mismatch") {
      assert.match(state.reason, /"origin" at/);
    }
  });

  it("reports a copy on another branch as a mismatch", async () => {
    const { remote, root } = remoteWith();
    const copy = join(root, "copy");
    const made = await parsedOrFail({ remote, branch: "main" }).materialize(copy);
    assert.equal(made.ok, true);
    execFileSync("git", ["checkout", "-b", "elsewhere"], { cwd: copy });
    const state = parsedOrFail({ remote, branch: "main" }).inspect(copy);
    assert.equal(state.kind, "mismatch");
    if (state.kind === "mismatch") {
      assert.match(state.reason, /on "elsewhere", not "main"/);
    }
  });

  it("treats .git and a trailing slash as the same remote", async () => {
    const { remote, root } = remoteWith();
    const copy = join(root, "copy");
    const made = await parsedOrFail({ remote, branch: "main" }).materialize(copy);
    assert.equal(made.ok, true);
    const spelled = parsedOrFail({ remote: `${remote.replace(/\.git$/, "")}/`, branch: "main" });
    assert.deepEqual(spelled.inspect(copy), { kind: "matches" });
  });
});
