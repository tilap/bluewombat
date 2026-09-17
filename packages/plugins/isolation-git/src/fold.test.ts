import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { runIntegrator } from "@bluewombat/integrator";
import { clearRunEnv, setRunEnv, strategy } from "./index.js";

function sandbox(): string {
  return mkdtempSync(join(tmpdir(), "isolation-git-fold-"));
}

function writeTree(root: string, files: Record<string, string>): void {
  mkdirSync(root, { recursive: true });
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

function gitInit(directory: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: directory });
  execFileSync("git", ["config", "user.email", "integrator@test.local"], { cwd: directory });
  execFileSync("git", ["config", "user.name", "Integrator Test"], { cwd: directory });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: directory });
}

function gitCommitAll(directory: string, message: string): void {
  execFileSync("git", ["add", "."], { cwd: directory });
  execFileSync("git", ["commit", "-m", message], { cwd: directory });
}

function gitPair(baseFiles: Record<string, string>): {
  parent: string;
  child: string;
  root: string;
} {
  const root = sandbox();
  const parent = join(root, "parent");
  writeTree(parent, baseFiles);
  gitInit(parent);
  gitCommitAll(parent, "init");
  const child = join(root, "child");
  execFileSync("git", ["worktree", "add", "--detach", child], { cwd: parent });
  return { parent, child, root };
}

function hasConflictMarkers(directory: string): boolean {
  const stack = [directory];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) {
      break;
    }
    for (const name of readdirSync(current, { withFileTypes: true })) {
      if (name.name === ".git") {
        continue;
      }
      const path = join(current, name.name);
      if (name.isDirectory()) {
        stack.push(path);
        continue;
      }
      if (name.isFile()) {
        const text = readFileSync(path, "utf8");
        if (text.includes("<<<<<<<") || text.includes(">>>>>>>")) {
          return true;
        }
      }
    }
  }
  return false;
}

describe("isolation-git fold", () => {
  it("path changed only in the Child → Parent gets Child bytes", async () => {
    const { parent, child } = gitPair({ "a.txt": "base" });
    writeFileSync(join(child, "a.txt"), "child");
    const result = await runIntegrator({
      backend: strategy.fold,
      invocation: { id: "feat-1", parent, child, durationMs: 30_000 },
      write: () => {},
    });
    assert.equal(result.outcome, "integrated");
    assert.equal(readFileSync(join(parent, "a.txt"), "utf8"), "child");
  });

  it("path changed only in the Parent → Parent keeps its bytes", async () => {
    const { parent, child } = gitPair({ "a.txt": "base" });
    writeFileSync(join(parent, "a.txt"), "parent");
    const result = await runIntegrator({
      backend: strategy.fold,
      invocation: { id: "feat-1", parent, child, durationMs: 30_000 },
      write: () => {},
    });
    assert.equal(result.outcome, "integrated");
    assert.equal(readFileSync(join(parent, "a.txt"), "utf8"), "parent");
    assert.equal(readFileSync(join(child, "a.txt"), "utf8"), "base");
  });

  it("both sides changed the same path → conflict; Parent restored", async () => {
    const { parent, child } = gitPair({ "a.txt": "base" });
    writeFileSync(join(parent, "a.txt"), "parent-only");
    writeFileSync(join(child, "a.txt"), "child-only");
    const result = await runIntegrator({
      backend: strategy.fold,
      invocation: { id: "feat-1", parent, child, durationMs: 30_000 },
      write: () => {},
    });
    assert.equal(result.outcome, "conflict");
    assert.equal(readFileSync(join(parent, "a.txt"), "utf8"), "parent-only");
    assert.equal(hasConflictMarkers(parent), false);
  });

  it("Child without .git → failed, not copy", async () => {
    const root = sandbox();
    const parent = join(root, "parent");
    writeTree(parent, { "a.txt": "tracked" });
    gitInit(parent);
    gitCommitAll(parent, "init");
    const child = join(root, "child");
    writeTree(child, { "b.txt": "incoming" });
    const result = await runIntegrator({
      backend: strategy.fold,
      invocation: { id: "feat-1", parent, child, durationMs: 30_000 },
      write: () => {},
    });
    assert.equal(result.outcome, "failed");
    assert.equal(existsSync(join(parent, "b.txt")), false);
  });

  it("Parent .git is not usable → failed, not copy", async () => {
    const root = sandbox();
    const parent = join(root, "parent");
    const child = join(root, "child");
    writeTree(parent, { "a.txt": "x" });
    writeTree(child, { "b.txt": "y" });
    writeFileSync(join(parent, ".git"), "not a git directory");
    const result = await runIntegrator({
      backend: strategy.fold,
      invocation: { id: "feat-1", parent, child, durationMs: 30_000 },
      write: () => {},
    });
    assert.equal(result.outcome, "failed");
    assert.equal(existsSync(join(parent, "b.txt")), false);
  });

  it("says in the history what was folded", async () => {
    const { parent, child } = gitPair({ "a.txt": "base\n" });
    writeFileSync(join(child, "new.txt"), "work\n");
    const result = await runIntegrator({
      backend: strategy.fold,
      invocation: {
        id: "github:tilap/mason-one#2",
        parent,
        child,
        durationMs: 30_000,
      },
      write: () => {},
    });
    assert.equal(result.outcome, "integrated");
    const log = execFileSync("git", ["log", "--format=%s", "-3"], {
      cwd: parent,
      encoding: "utf8",
    });
    assert.match(log, /Integration of github:tilap\/mason-one#2/);
  });

  it("leaves one commit, named after the work, when only the Child moved", async () => {
    const { parent, child } = gitPair({ "a.txt": "base\n" });
    writeFileSync(join(child, "new.txt"), "work\n");
    const result = await runIntegrator({
      backend: strategy.fold,
      invocation: {
        id: "s1",
        parent,
        child,
        durationMs: 30_000,
        subject: "Add the slugify helper",
        mergeSubject: "Merge s1 into the feature",
      },
      write: () => {},
    });
    assert.equal(result.outcome, "integrated");
    assert.deepEqual(gitLog(parent), ["Add the slugify helper", "init"]);
    assert.equal(readFileSync(join(parent, "new.txt"), "utf8"), "work\n");
  });

  it("signs what it commits with the run's identity, not the machine's", async () => {
    const { parent, child } = gitPair({ "a.txt": "base\n" });
    writeFileSync(join(child, "new.txt"), "work\n");
    setRunEnv({
      GIT_AUTHOR_NAME: "mason",
      GIT_AUTHOR_EMAIL: "mason@example.test",
      GIT_COMMITTER_NAME: "mason",
      GIT_COMMITTER_EMAIL: "mason@example.test",
    });
    try {
      const result = await runIntegrator({
        backend: strategy.fold,
        invocation: { id: "s1", parent, child, durationMs: 30_000, subject: "Add new.txt" },
        write: () => {},
      });
      assert.equal(result.outcome, "integrated");
    } finally {
      clearRunEnv();
    }
    const signed = execFileSync("git", ["log", "-1", "--format=%an <%ae> %cn <%ce>"], {
      cwd: parent,
      encoding: "utf8",
    }).trim();
    assert.equal(signed, "mason <mason@example.test> mason <mason@example.test>");
  });

  it("snapshots the Child through its own index, leaving the Child's index alone", async () => {
    const { parent, child } = gitPair({ "a.txt": "base\n" });
    writeFileSync(join(child, "new.txt"), "work\n");
    const before = execFileSync("git", ["status", "--porcelain"], { cwd: child, encoding: "utf8" });
    const result = await runIntegrator({
      backend: strategy.fold,
      invocation: { id: "s1", parent, child, durationMs: 30_000, subject: "Add new.txt" },
      write: () => {},
    });
    assert.equal(result.outcome, "integrated");
    const after = execFileSync("git", ["status", "--porcelain"], { cwd: child, encoding: "utf8" });
    // `??` before, `??` after: the snapshot was taken in a temporary index.
    assert.equal(after, before);
    assert.match(before, /^\?\? new\.txt/m);
  });

  it("leaves nothing when the Child has nothing the Parent lacks", async () => {
    const { parent, child } = gitPair({ "a.txt": "base\n" });
    const invocation = { id: "align", parent, child, durationMs: 30_000, subject: "Align" };
    const first = await runIntegrator({ backend: strategy.fold, invocation, write: () => {} });
    assert.equal(first.outcome, "integrated");
    assert.deepEqual(gitLog(parent), ["init"]);
    // The Parent moved on its own; the Child still has nothing new.
    writeFileSync(join(parent, "b.txt"), "parent\n");
    gitCommitAll(parent, "parent work");
    const second = await runIntegrator({ backend: strategy.fold, invocation, write: () => {} });
    assert.equal(second.outcome, "integrated");
    assert.deepEqual(gitLog(parent), ["parent work", "init"]);
  });

  it("leaves one merge commit, named after the fold, when both sides moved", async () => {
    const { parent, child } = gitPair({ "a.txt": "base\n" });
    writeFileSync(join(parent, "b.txt"), "parent\n");
    gitCommitAll(parent, "parent work");
    writeFileSync(join(child, "c.txt"), "child\n");
    const result = await runIntegrator({
      backend: strategy.fold,
      invocation: {
        id: "align",
        parent,
        child,
        durationMs: 30_000,
        subject: "Child work",
        mergeSubject: "Merge main into the feature",
      },
      write: () => {},
    });
    assert.equal(result.outcome, "integrated");
    assert.deepEqual(gitLog(parent).sort(), [
      "Child work",
      "Merge main into the feature",
      "init",
      "parent work",
    ]);
    assert.equal(gitLog(parent)[0], "Merge main into the feature");
    assert.ok(existsSync(join(parent, "b.txt")) && existsSync(join(parent, "c.txt")));
  });
});

function gitLog(directory: string): string[] {
  return execFileSync("git", ["log", "--format=%s"], { cwd: directory, encoding: "utf8" })
    .trim()
    .split("\n");
}
