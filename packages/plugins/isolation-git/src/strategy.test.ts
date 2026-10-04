import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { runIsolator } from "@bluewombat/isolator";
import { branchNameOf, createStrategy, isExcluded, strategy } from "./index.js";

function sandbox(): string {
  return mkdtempSync(join(tmpdir(), "isolation-git-"));
}

function copyParent(files: Record<string, string>): { parent: string; root: string } {
  const root = sandbox();
  const parent = join(root, "parent");
  mkdirSync(parent);
  for (const [relative, content] of Object.entries(files)) {
    const path = join(parent, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return { parent, root };
}

function gitParent(files: Record<string, string> = { "a.txt": "hello" }): {
  parent: string;
  root: string;
} {
  const { parent, root } = copyParent(files);
  execFileSync("git", ["init", "-b", "main"], { cwd: parent });
  execFileSync("git", ["config", "user.email", "isolator@test.local"], { cwd: parent });
  execFileSync("git", ["config", "user.name", "Isolator Test"], { cwd: parent });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: parent });
  execFileSync("git", ["add", "."], { cwd: parent });
  execFileSync("git", ["commit", "-m", "init"], { cwd: parent });
  return { parent, root };
}

describe("isolation-git strategy", () => {
  it("isolates via git worktree; Child is a worktree; independence holds", async () => {
    const { parent, root } = gitParent({ "a.txt": "tracked" });
    writeFileSync(join(parent, "untracked.txt"), "u");
    writeFileSync(join(parent, "a.txt"), "dirty");
    const child = join(root, "child");
    const result = await runIsolator({
      backend: strategy.isolation,
      invocation: { id: "feat-1", parent, child, durationMs: 30_000 },
      write: () => {},
    });
    assert.equal(result.outcome, "isolated");
    assert.ok(statSync(join(child, ".git")).isFile());
    assert.match(readFileSync(join(child, ".git"), "utf8"), /^gitdir:/);
    assert.equal(readFileSync(join(child, "a.txt"), "utf8"), "dirty");
    assert.equal(readFileSync(join(child, "untracked.txt"), "utf8"), "u");
    writeFileSync(join(child, "only-child.txt"), "c");
    assert.equal(existsSync(join(parent, "only-child.txt")), false);
  });

  it("fails when git cannot complete, not a copy", async () => {
    const { parent, root } = copyParent({ "a.txt": "x" });
    writeFileSync(join(parent, ".git"), "not a git directory");
    const child = join(root, "child");
    const result = await runIsolator({
      backend: strategy.isolation,
      invocation: { id: "feat-1", parent, child, durationMs: 30_000 },
      write: () => {},
    });
    assert.equal(result.outcome, "failed");
    assert.equal(existsSync(child), false);
  });

  it("names the branch after the Isolation id", async () => {
    const { parent, root } = gitParent({ "a.txt": "tracked" });
    const child = join(root, "child");
    const result = await runIsolator({
      backend: strategy.isolation,
      invocation: {
        id: "github:tilap/mason-one#2",
        parent,
        child,
        durationMs: 30_000,
      },
      write: () => {},
    });
    assert.equal(result.outcome, "isolated");
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: child,
      encoding: "utf8",
    }).trim();
    assert.equal(branch, "issue/2");
    assert.equal(branchNameOf("github:tilap/mason-one#2"), branch);
    assert.equal(strategy.refOf("github:tilap/mason-one#2"), branch);
  });

  it("starts from the Parent when that name is already taken", async () => {
    const { parent, root } = gitParent({ "a.txt": "v1" });
    execFileSync("git", ["branch", "issue/feat-1"], { cwd: parent });
    writeFileSync(join(parent, "a.txt"), "v2");
    execFileSync("git", ["commit", "-am", "second"], { cwd: parent });
    const child = join(root, "child");
    const result = await runIsolator({
      backend: strategy.isolation,
      invocation: { id: "feat-1", parent, child, durationMs: 30_000 },
      write: () => {},
    });
    assert.equal(result.outcome, "isolated");
    assert.equal(readFileSync(join(child, "a.txt"), "utf8"), "v2");
  });

  it("isolates again at a path whose Child was deleted from disk", async () => {
    const { parent, root } = gitParent();
    const child = join(root, "child");
    const invocation = { id: "feat-1", parent, child, durationMs: 30_000 };
    const first = await runIsolator({ backend: strategy.isolation, invocation, write: () => {} });
    assert.equal(first.outcome, "isolated");
    // What Conductor does to a finished or abandoned Child: rm -rf, no git.
    rmSync(child, { recursive: true, force: true });
    const second = await runIsolator({ backend: strategy.isolation, invocation, write: () => {} });
    assert.equal(second.outcome, "isolated");
    assert.equal(readFileSync(join(child, "a.txt"), "utf8"), "hello");
  });

  it("git Child can be Parent of a later Isolation", async () => {
    const { parent, root } = gitParent({ "a.txt": "v1" });
    const child1 = join(root, "child-1");
    const first = await runIsolator({
      backend: strategy.isolation,
      invocation: { id: "feat-1", parent, child: child1, durationMs: 30_000 },
      write: () => {},
    });
    assert.equal(first.outcome, "isolated");
    writeFileSync(join(child1, "from-first.txt"), "yes");
    const child2 = join(root, "child-2");
    const second = await runIsolator({
      backend: strategy.isolation,
      invocation: { id: "feat-2", parent: child1, child: child2, durationMs: 30_000 },
      write: () => {},
    });
    assert.equal(second.outcome, "isolated");
    assert.ok(statSync(join(child2, ".git")).isFile());
    assert.equal(readFileSync(join(child2, "a.txt"), "utf8"), "v1");
    assert.equal(readFileSync(join(child2, "from-first.txt"), "utf8"), "yes");
  });
});

describe("what a Child does not get", () => {
  it("leaves untracked .env and .env.* behind by default, at any depth, and keeps the rest", async () => {
    const { parent, root } = gitParent({
      "a.txt": "tracked",
      "env.txt": "not a secret",
      "packages/api/index.js": "export {}",
    });
    // On disk only: what a Builder must not read.
    for (const [path, text] of Object.entries({
      ".env": "SECRET=1",
      ".env.local": "SECRET=2",
      "packages/api/.env": "SECRET=3",
      "docs/.env.example": "SECRET=",
    })) {
      mkdirSync(dirname(join(parent, path)), { recursive: true });
      writeFileSync(join(parent, path), text);
    }
    const child = join(root, "child");
    const result = await runIsolator({
      backend: strategy.isolation,
      invocation: { id: "feat-1", parent, child, durationMs: 30_000 },
      write: () => {},
    });
    assert.equal(result.outcome, "isolated");
    for (const gone of [".env", ".env.local", "packages/api/.env", "docs/.env.example"]) {
      assert.equal(existsSync(join(child, gone)), false, gone);
    }
    for (const kept of ["a.txt", "env.txt", "packages/api/index.js"]) {
      assert.equal(existsSync(join(child, kept)), true, kept);
    }
    // The Parent is untouched: exclusion is about the copy, not the source.
    assert.equal(readFileSync(join(parent, ".env"), "utf8"), "SECRET=1");
  });

  it("never leaves out a path git tracks: it would read as a deletion", async () => {
    const { parent, root } = gitParent({
      "a.txt": "tracked",
      ".env.example": "SECRET=",
      "packages/api/.env.example": "SECRET=",
      "vendor/lib.js": "tracked inside an excluded directory",
    });
    writeFileSync(join(parent, ".env"), "SECRET=1");
    writeFileSync(join(parent, "vendor/stray.js"), "untracked inside it");
    const made = createStrategy({ exclude: [".env", ".env.*", "vendor"] });
    assert.ok(made.ok, made.ok ? "" : made.reason);
    const child = join(root, "child");
    const result = await runIsolator({
      backend: made.strategy.isolation,
      invocation: { id: "feat-5", parent, child, durationMs: 30_000 },
      write: () => {},
    });
    assert.equal(result.outcome, "isolated");
    assert.equal(existsSync(join(child, ".env")), false);
    assert.equal(existsSync(join(child, "vendor/stray.js")), false);
    for (const kept of [".env.example", "packages/api/.env.example", "vendor/lib.js"]) {
      assert.equal(existsSync(join(child, kept)), true, kept);
    }
    // The Child is clean: nothing it was given reads as a change to the history.
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: child, encoding: "utf8" });
    assert.equal(status.trim(), "");
  });

  it("takes the Project's own list in place of the default", async () => {
    const made = createStrategy({ exclude: ["node_modules", "**/*.log", "build/out"] });
    assert.ok(made.ok, made.ok ? "" : made.reason);
    const { parent, root } = gitParent({
      "a.txt": "tracked",
      ".env": "kept now",
      "build/keep": "source",
    });
    // What a build leaves on disk, untracked.
    for (const [path, text] of Object.entries({
      "node_modules/dep/index.js": "x",
      "deep/er/run.log": "log",
      "build/out": "artefact",
    })) {
      mkdirSync(dirname(join(parent, path)), { recursive: true });
      writeFileSync(join(parent, path), text);
    }
    const child = join(root, "child");
    const result = await runIsolator({
      backend: made.strategy.isolation,
      invocation: { id: "feat-2", parent, child, durationMs: 30_000 },
      write: () => {},
    });
    assert.equal(result.outcome, "isolated");
    assert.equal(existsSync(join(child, "node_modules")), false);
    assert.equal(existsSync(join(child, "deep/er/run.log")), false);
    assert.equal(existsSync(join(child, "build/out")), false);
    assert.equal(existsSync(join(child, "build/keep")), true);
    assert.equal(readFileSync(join(child, ".env"), "utf8"), "kept now");
  });

  it("copies a symbolic link as a link, not as what it points to", async () => {
    const { parent, root } = gitParent({ "real.txt": "r" });
    symlinkSync("real.txt", join(parent, "link.txt"));
    const child = join(root, "child");
    const result = await runIsolator({
      backend: strategy.isolation,
      invocation: { id: "feat-3", parent, child, durationMs: 30_000 },
      write: () => {},
    });
    assert.equal(result.outcome, "isolated");
    assert.ok(lstatSync(join(child, "link.txt")).isSymbolicLink());
    assert.equal(readlinkSync(join(child, "link.txt")), "real.txt");
  });

  it("refuses options it does not read, and a list that is not one", () => {
    const unknown = createStrategy({ excludes: [".env"] });
    assert.equal(unknown.ok, false);
    assert.match(unknown.ok ? "" : unknown.reason, /"excludes" is not one/);
    const wrong = createStrategy({ exclude: ".env" });
    assert.equal(wrong.ok, false);
    assert.match(wrong.ok ? "" : wrong.reason, /must be a list/);
    const empty = createStrategy({ exclude: [] });
    assert.ok(empty.ok);
  });
});

describe("isExcluded", () => {
  it("matches a bare name at any depth, a path from the root, and the two stars", () => {
    const patterns = [".env", ".env.*", "build/out", "**/*.log", "cache-*"];
    for (const hit of [
      ".env",
      "a/b/.env",
      ".env.local",
      "x/.env.production",
      "build/out",
      "run.log",
      "deep/er/run.log",
      "cache-v2",
      "pkg/cache-old",
    ]) {
      assert.ok(isExcluded(hit, patterns), hit);
    }
    for (const miss of [
      "env",
      "env.txt",
      "my.env",
      "build/out/x",
      "src/build/out",
      "logs",
      "cache",
    ]) {
      assert.equal(isExcluded(miss, patterns), false, miss);
    }
  });
});

describe("branchNameOf", () => {
  it("keeps the item number of a tracked id, and the whole slug of any other", () => {
    assert.equal(branchNameOf("github:tilap/mason-one#2"), "issue/2");
    assert.equal(branchNameOf("github:tilap/mason-one#2:s1"), "issue/2-s1");
    assert.equal(branchNameOf("gitlab:group/sub/app#310"), "issue/310");
    assert.equal(branchNameOf("fake:42"), "issue/fake-42");
    assert.equal(branchNameOf("jira:APP-123"), "issue/jira-app-123");
    assert.equal(branchNameOf("  "), "issue/isolation");
  });

  it("keeps two long ids apart past the cut, with a digest of the whole id", () => {
    const stem = "x".repeat(90);
    const one = branchNameOf(`${stem}-one`);
    const two = branchNameOf(`${stem}-two`);
    assert.notEqual(one, two);
    assert.ok(one.length <= "issue/".length + 80, one);
    assert.match(one, /^issue\/x+-[0-9a-f]{7}$/);
    // Deterministic: the Publisher derives the same name from the same id.
    assert.equal(one, branchNameOf(`${stem}-one`));
    // Nothing changes for an id that fits.
    assert.equal(branchNameOf("jira:APP-123"), "issue/jira-app-123");
  });
});
