import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const publisher = join(dirname(fileURLToPath(import.meta.url)), "../publishers/git.mjs");

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

function identity(dir: string): void {
  git(dir, "config", "user.email", "p@test.local");
  git(dir, "config", "user.name", "P");
  git(dir, "config", "commit.gpgsign", "false");
}

function commit(dir: string, message: string): void {
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", message);
}

/** A bare remote holding `main`, and the work line cloned from it, with the Ticket's branch cut. */
function setup(): { workLine: string; remote: string } {
  const root = mkdtempSync(join(tmpdir(), "host-publisher-"));
  const remote = join(root, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  const seed = join(root, "seed");
  execFileSync("git", ["init", "-q", "-b", "main", seed]);
  identity(seed);
  writeFileSync(join(seed, "a.txt"), "a");
  commit(seed, "a");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-q", "origin", "main");
  const workLine = join(root, "work-line");
  execFileSync("git", ["clone", "-q", remote, workLine]);
  identity(workLine);
  git(workLine, "checkout", "-q", "-b", "issue/1");
  return { workLine, remote };
}

function publish(cwd: string): { ref?: string; reason?: string } {
  const result = spawnSync(
    process.execPath,
    [publisher, "--id", "t:1", "--ref", "issue/1", "--target", "main"],
    {
      cwd,
      encoding: "utf8",
    },
  );
  return JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}");
}

describe("git publisher", () => {
  it("pushes the Ticket's result as one commit on the line, not what the workspace went through", () => {
    const { workLine, remote } = setup();
    writeFileSync(join(workLine, "installed.bin"), "a blob an install left");
    commit(workLine, "snapshot with the install");
    const blob = git(workLine, "rev-parse", "HEAD:installed.bin");
    rmSync(join(workLine, "installed.bin"));
    writeFileSync(join(workLine, "feature.txt"), "the work");
    commit(workLine, "snapshot after the repair");

    assert.equal(publish(workLine).ref, "issue/1");

    const tip = git(remote, "rev-parse", "issue/1");
    assert.equal(git(remote, "rev-list", "--count", "main..issue/1"), "1");
    assert.equal(git(remote, "rev-parse", `${tip}^`), git(remote, "rev-parse", "main"));
    assert.equal(
      git(remote, "rev-parse", `${tip}^{tree}`),
      git(workLine, "rev-parse", "HEAD^{tree}"),
    );
    assert.equal(git(remote, "diff", "--name-only", "main", "issue/1"), "feature.txt");
    const held = spawnSync("git", ["-C", remote, "cat-file", "-e", blob]);
    assert.notEqual(held.status, 0, "the blob that was added then removed was not pushed");
  });

  it("continues what it published, so a resubmission is a fast-forward", () => {
    const { workLine, remote } = setup();
    writeFileSync(join(workLine, "feature.txt"), "v1");
    commit(workLine, "v1");
    publish(workLine);
    const first = git(remote, "rev-parse", "issue/1");

    writeFileSync(join(workLine, "feature.txt"), "v2");
    commit(workLine, "v2");
    assert.equal(publish(workLine).ref, "issue/1");

    const second = git(remote, "rev-parse", "issue/1");
    assert.notEqual(second, first);
    assert.equal(git(remote, "merge-base", first, second), first);
  });

  it("publishes nothing new for the same tree on the same line", () => {
    const { workLine, remote } = setup();
    writeFileSync(join(workLine, "feature.txt"), "v1");
    commit(workLine, "v1");
    publish(workLine);
    const first = git(remote, "rev-parse", "issue/1");

    assert.equal(publish(workLine).ref, "issue/1");

    assert.equal(git(remote, "rev-parse", "issue/1"), first);
  });

  it("refuses a name that moved under it, and leaves it as it is", () => {
    const { workLine, remote } = setup();
    writeFileSync(join(workLine, "feature.txt"), "mine");
    commit(workLine, "mine");
    const elsewhere = join(dirname(workLine), "elsewhere");
    execFileSync("git", ["clone", "-q", remote, elsewhere]);
    identity(elsewhere);
    git(elsewhere, "checkout", "-q", "-b", "issue/1");
    writeFileSync(join(elsewhere, "theirs.txt"), "theirs");
    commit(elsewhere, "theirs");
    git(elsewhere, "push", "-q", "origin", "issue/1");
    const theirs = git(remote, "rev-parse", "issue/1");

    const answer = publish(workLine);

    assert.equal(answer.ref, undefined);
    assert.match(answer.reason ?? "", /Could not publish issue\/1/);
    assert.equal(git(remote, "rev-parse", "issue/1"), theirs);
  });
});
