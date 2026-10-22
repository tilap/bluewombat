import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const refresher = join(dirname(fileURLToPath(import.meta.url)), "../refreshers/git.mjs");

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

/** A remote with `main` and `feature/x` (one more commit), and a single-branch clone of `main`. */
function setup(): { copy: string; remote: string } {
  const root = mkdtempSync(join(tmpdir(), "host-refresher-"));
  const remote = join(root, "remote");
  execFileSync("git", ["init", "-q", "-b", "main", remote]);
  git(remote, "config", "user.email", "r@test.local");
  git(remote, "config", "user.name", "R");
  git(remote, "config", "commit.gpgsign", "false");
  writeFileSync(join(remote, "a.txt"), "a");
  git(remote, "add", "-A");
  git(remote, "commit", "-qm", "a");
  git(remote, "checkout", "-q", "-b", "feature/x");
  writeFileSync(join(remote, "b.txt"), "b");
  git(remote, "add", "-A");
  git(remote, "commit", "-qm", "b");
  git(remote, "checkout", "-q", "main");
  const copy = join(root, "copy");
  execFileSync("git", ["clone", "-q", "--single-branch", "--branch", "main", remote, copy]);
  return { copy, remote };
}

function refresh(cwd: string, target: string, base?: string): "refreshed" | "refused" {
  const args = base === undefined ? [] : ["--base", base];
  const result = spawnSync(process.execPath, [refresher, "--target", target, ...args], {
    cwd,
    encoding: "utf8",
  });
  const line = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}");
  return line.ok === true ? "refreshed" : "refused";
}

describe("git refresher", () => {
  it("moves a copy onto a line it has never fetched", () => {
    const { copy } = setup();
    assert.equal(refresh(copy, "feature/x"), "refreshed");
    assert.equal(git(copy, "symbolic-ref", "--short", "HEAD"), "feature/x");
    assert.equal(existsSync(join(copy, "b.txt")), true);
  });

  it("moves back to the final branch and fast-forwards it", () => {
    const { copy, remote } = setup();
    refresh(copy, "feature/x");
    writeFileSync(join(remote, "c.txt"), "c");
    git(remote, "add", "-A");
    git(remote, "commit", "-qm", "c");
    assert.equal(refresh(copy, "main"), "refreshed");
    assert.equal(git(copy, "symbolic-ref", "--short", "HEAD"), "main");
    assert.equal(existsSync(join(copy, "c.txt")), true);
    assert.equal(existsSync(join(copy, "b.txt")), false);
  });

  it("refuses a line the remote does not have", () => {
    const { copy } = setup();
    assert.equal(refresh(copy, "feature/none"), "refused");
  });

  describe("a feature line given its base", () => {
    /** `feature/y` cut from main's only commit, then main moves on by one. */
    function behind(): { copy: string; remote: string; mainTip: string } {
      const { copy, remote } = setup();
      git(remote, "branch", "feature/y", "main");
      writeFileSync(join(remote, "c.txt"), "c");
      git(remote, "add", "-A");
      git(remote, "commit", "-qm", "c");
      return { copy, remote, mainTip: git(remote, "rev-parse", "main") };
    }

    it("fast-forwards a line with no commit of its own to the base, copy and remote", () => {
      const { copy, remote, mainTip } = behind();
      assert.equal(refresh(copy, "feature/y", "main"), "refreshed");
      assert.equal(git(copy, "symbolic-ref", "--short", "HEAD"), "feature/y");
      assert.equal(git(copy, "rev-parse", "HEAD"), mainTip);
      assert.equal(git(remote, "rev-parse", "feature/y"), mainTip);
    });

    it("leaves a line with commits of its own where it is", () => {
      const { copy, remote } = behind();
      const own = git(remote, "rev-parse", "feature/x");
      assert.equal(refresh(copy, "feature/x", "main"), "refreshed");
      assert.equal(git(copy, "rev-parse", "HEAD"), own);
      assert.equal(git(remote, "rev-parse", "feature/x"), own);
    });

    it("does nothing when the line already is the base", () => {
      const { copy, remote } = setup();
      git(remote, "branch", "feature/y", "main");
      const tip = git(remote, "rev-parse", "main");
      assert.equal(refresh(copy, "feature/y", "main"), "refreshed");
      assert.equal(git(copy, "rev-parse", "HEAD"), tip);
    });

    it("refuses a base the remote does not have", () => {
      const { copy } = behind();
      assert.equal(refresh(copy, "feature/y", "nowhere"), "refused");
    });
  });
});
