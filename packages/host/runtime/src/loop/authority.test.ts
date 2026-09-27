import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { strategy } from "@bluewombat/isolation-git";
import type { ManagerPort, SubmissionRequest } from "@bluewombat/manager-kit";
import { openAuthority, refreshWorkLine } from "./authority.js";

/**
 * A remote is a repository with no working tree, and nothing says it has to be
 * on a server. `git init --bare` in a temporary directory answers push and
 * fetch exactly as GitHub does, with no network and no credentials.
 *
 * The clone is `--single-branch` on purpose, because that is what `mason init`
 * makes and it is the shape that matters: such a clone has a remote-tracking
 * ref for one branch and none for the others. A full clone has them all and
 * hides everything this file is here to catch.
 */

const TARGET = "dev";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

function identify(dir: string): void {
  git(dir, ["config", "user.email", "authority@test.local"]);
  git(dir, ["config", "user.name", "Authority Test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
}

function commit(dir: string, name: string, body: string): void {
  writeFileSync(join(dir, name), body);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", `add ${name}`]);
}

/** A bare remote holding `dev`, and the single-branch clone Host works in. */
function remoteAndCopy(): { remote: string; copy: string } {
  const root = mkdtempSync(join(tmpdir(), "authority-"));
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const copy = join(root, "work-line");
  mkdirSync(seed);
  execFileSync("git", ["init", "-q", "--bare", "-b", TARGET, remote]);
  execFileSync("git", ["init", "-q", "-b", TARGET, seed]);
  identify(seed);
  commit(seed, "seed.txt", "one\n");
  git(seed, ["push", "-q", remote, TARGET]);
  execFileSync("git", ["clone", "-q", "--branch", TARGET, "--single-branch", remote, copy]);
  identify(copy);
  return { remote, copy };
}

/** A second clone, standing for whoever else can write to that remote. */
function otherWorkingCopy(remote: string, branch: string): string {
  const dir = mkdtempSync(join(tmpdir(), "authority-other-"));
  execFileSync("git", ["clone", "-q", "--branch", branch, "--single-branch", remote, dir]);
  identify(dir);
  return dir;
}

/** The work a feature leaves: a named branch in the work line copy. */
function featureBranch(copy: string, branch: string, file: string): void {
  const exists = git(copy, ["branch", "--list", branch]).trim().length > 0;
  git(copy, exists ? ["checkout", "-q", branch] : ["checkout", "-q", "-b", branch]);
  commit(copy, file, "work\n");
}

function stubManager(seen: SubmissionRequest[]): ManagerPort {
  return {
    async listen() {
      return { outcome: "listened", deliveries: [] };
    },
    async adapt() {
      return { outcome: "unavailable" };
    },
    async report() {
      return true;
    },
    async submit(input) {
      seen.push(input);
      return { outcome: "submitted", reference: "ref-1" };
    },
    async fold() {
      return { outcome: "folded" };
    },
  };
}

/** The shipped git Publisher, run as the slot it is. */
const GIT_PUBLISHER = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../plugins/slots/publishers/git.mjs",
);
/** The shipped git Refresher, run as the slot it is. */
const GIT_REFRESHER = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../plugins/slots/refreshers/git.mjs",
);
function refreshOn(copy: string) {
  return refreshWorkLine({
    workLineStable: copy,
    workLineTarget: TARGET,
    refreshArgv: ["node", GIT_REFRESHER],
    timeoutMs: 60_000,
  });
}

function authorityOn(
  copy: string,
  seen: SubmissionRequest[],
  publishArgv?: string[],
  env?: Record<string, string>,
  describer?: { cmd: string[]; timeoutMs: number; workspaceRoot: string },
) {
  const authority = openAuthority({
    manager: stubManager(seen),
    workLineStable: copy,
    workLineTarget: TARGET,
    publishArgv: publishArgv ?? ["node", GIT_PUBLISHER],
    timeoutMs: 60_000,
    refOf: strategy.refOf,
    env,
    ...(describer === undefined
      ? {}
      : {
          describe: { cmd: describer.cmd, timeoutMs: describer.timeoutMs },
          workspaceRoot: describer.workspaceRoot,
        }),
  });
  assert.ok(authority !== undefined, "a manager with submit and fold is an Authority");
  return authority;
}

function offer(): SubmissionRequest {
  return { key: "fake:42", project: "proj", ref: "fake:42", target: TARGET };
}

describe("the Authority against a real remote", () => {
  it("publishes the feature's branch, then names it to the FeatureManager", async () => {
    const { remote, copy } = remoteAndCopy();
    featureBranch(copy, "issue/fake-42", "work.txt");
    const seen: SubmissionRequest[] = [];

    const result = await authorityOn(copy, seen).submit(offer());

    assert.deepEqual(result, { outcome: "submitted", reference: "ref-1" });
    assert.match(git(remote, ["branch", "--list", "issue/fake-42"]), /issue\/fake-42/);
    // What travels is the published name, not the key and not a path on this
    // machine: it is the only half of the pair the outside can read.
    assert.equal(seen[0]?.ref, "issue/fake-42");
    assert.equal(seen[0]?.target, TARGET);
  });

  it("refuses the Submission when the Publisher refuses, without asking the manager", async () => {
    // The Publisher is a slot: what it cannot place, the Authority cannot
    // offer. The refusal is the slot's own words, and the tracker never hears
    // about a Submission that does not exist.
    const { copy } = remoteAndCopy();
    const refusing = join(mkdtempSync(join(tmpdir(), "publisher-")), "no.mjs");
    writeFileSync(
      refusing,
      'console.log(JSON.stringify({ outcome: "refused", reason: "the shelf is full" }));',
    );
    const seen: SubmissionRequest[] = [];

    const result = await authorityOn(copy, seen, ["node", refusing]).submit(offer());

    assert.deepEqual(result, { outcome: "refused", reason: "the shelf is full" });
    assert.equal(seen.length, 0);
  });

  it("journals a refused offer: who refused, and in their words", async () => {
    // The reason also reaches the escalation, but `mason log` and a watcher
    // read the journal: without this line the film showed a run that simply
    // stopped at "escalated".
    const { copy } = remoteAndCopy();
    const dir = mkdtempSync(join(tmpdir(), "publisher-"));
    const refusing = join(dir, "no.mjs");
    writeFileSync(
      refusing,
      'console.log(JSON.stringify({ outcome: "refused", reason: "the shelf is full" }));',
    );
    const placing = join(dir, "yes.mjs");
    writeFileSync(placing, 'console.log(JSON.stringify({ ref: "issue/fake-42" }));');
    const offerWith = (publisher: string, manager: ManagerPort) => {
      const lines: Record<string, unknown>[] = [];
      const authority = openAuthority({
        manager,
        workLineStable: copy,
        workLineTarget: TARGET,
        publishArgv: ["node", publisher],
        timeoutMs: 60_000,
        refOf: strategy.refOf,
        journal: { append: (line) => lines.push(line) },
      });
      assert.ok(authority !== undefined);
      return { lines, submit: () => authority.submit(offer()) };
    };

    const byPublisher = offerWith(refusing, stubManager([]));
    await byPublisher.submit();
    assert.deepEqual(byPublisher.lines, [
      { event: "submit-refused", key: "fake:42", by: "publisher", reason: "the shelf is full" },
    ]);

    const closing: ManagerPort = {
      ...stubManager([]),
      async submit() {
        return { outcome: "refused", reason: "Validation Failed: no commits between dev and it" };
      },
    };
    const byAuthority = offerWith(placing, closing);
    const result = await byAuthority.submit();
    assert.equal(result.outcome, "refused");
    assert.deepEqual(byAuthority.lines, [
      {
        event: "submit-refused",
        key: "fake:42",
        by: "authority",
        reason: "Validation Failed: no commits between dev and it",
      },
    ]);

    const accepted = offerWith(placing, stubManager([]));
    await accepted.submit();
    assert.deepEqual(accepted.lines, [], "a Submission that happened is not a refusal");
  });

  it("hands the Publisher the work line's environment, and nothing else does", async () => {
    // The identity and credentials the reference named reach the slot that
    // pushes — and only through this call: Host's own environment stays clean,
    // so a Builder never inherits a token.
    const { copy } = remoteAndCopy();
    const echoing = join(mkdtempSync(join(tmpdir(), "publisher-")), "echo.mjs");
    writeFileSync(
      echoing,
      'console.log(JSON.stringify({ ref: process.env.GIT_AUTHOR_NAME + ":" + process.env.GIT_CONFIG_KEY_0 }));',
    );
    const seen: SubmissionRequest[] = [];
    const env = { GIT_AUTHOR_NAME: "mason", GIT_CONFIG_KEY_0: "credential.helper" };

    const result = await authorityOn(copy, seen, ["node", echoing], env).submit(offer());

    assert.equal(result.outcome, "submitted");
    assert.equal(seen[0]?.ref, "mason:credential.helper");
    assert.equal(process.env.GIT_AUTHOR_NAME, undefined);
  });

  it("hands the Refresher the same environment", () => {
    const { copy } = remoteAndCopy();
    const echoing = join(mkdtempSync(join(tmpdir(), "refresher-")), "echo.mjs");
    writeFileSync(
      echoing,
      'console.log(JSON.stringify(process.env.GIT_AUTHOR_NAME === "mason" ? { ok: true } : { ok: false, reason: "no identity" }));',
    );
    const refreshed = refreshWorkLine({
      workLineStable: copy,
      workLineTarget: TARGET,
      refreshArgv: ["node", echoing],
      timeoutMs: 60_000,
      env: { GIT_AUTHOR_NAME: "mason" },
    });
    assert.deepEqual(refreshed, { ok: true });
  });

  it("asks the Describer for the work's own words, in the feature workspace, and offers them", async () => {
    const { copy } = remoteAndCopy();
    const root = mkdtempSync(join(tmpdir(), "workspaces-"));
    const featureDir = join(root, encodeURIComponent("fake:42"), "feature");
    mkdirSync(featureDir, { recursive: true });
    writeFileSync(join(featureDir, "marker.txt"), "");
    const slot = join(root, "describer.mjs");
    writeFileSync(
      slot,
      [
        'import { existsSync } from "node:fs";',
        'const title = process.argv[process.argv.indexOf("--title") + 1];',
        'console.log(JSON.stringify({ subject: "feat: " + title + (existsSync("marker.txt") ? " (in its workspace)" : ""), body: "All of it." }));',
        "",
      ].join("\n"),
    );
    const seen: SubmissionRequest[] = [];
    featureBranch(copy, "issue/fake-42", "work.txt");

    const result = await authorityOn(copy, seen, undefined, undefined, {
      cmd: ["node", slot],
      timeoutMs: 60_000,
      workspaceRoot: root,
    }).submit(offer());

    assert.equal(result.outcome, "submitted");
    assert.deepEqual(seen[0]?.description, {
      subject: "feat: fake:42 (in its workspace)",
      body: "All of it.",
    });
  });

  it("names the Publisher's own reference to the manager", async () => {
    // The reference is opaque above Host: a branch today, a directory or a URL
    // for a Project that publishes some other way. Whatever the slot answers is
    // what the Authority is told to look at.
    const { copy } = remoteAndCopy();
    const naming = join(mkdtempSync(join(tmpdir(), "publisher-")), "elsewhere.mjs");
    writeFileSync(naming, 'console.log(JSON.stringify({ ref: "shelf/42" }));');
    const seen: SubmissionRequest[] = [];

    const result = await authorityOn(copy, seen, ["node", naming]).submit(offer());

    assert.deepEqual(result, { outcome: "submitted", reference: "ref-1" });
    assert.equal(seen[0]?.ref, "shelf/42");
  });

  it("publishes to the same branch again after a repair", async () => {
    const { remote, copy } = remoteAndCopy();
    featureBranch(copy, "issue/fake-42", "work.txt");
    const seen: SubmissionRequest[] = [];
    const authority = authorityOn(copy, seen);
    await authority.submit(offer());

    commit(copy, "repair.txt", "fixed\n");
    const again = await authority.submit(offer());

    // The regression this file exists for. `--force-with-lease` was rejected
    // here every time: a single-branch clone has no remote-tracking ref for
    // this branch, so there is nothing to lease against and git refuses on
    // "stale info". A full clone has that ref and the bug never shows.
    assert.deepEqual(again, { outcome: "submitted", reference: "ref-1" });
    assert.match(git(remote, ["log", "--oneline", "issue/fake-42"]), /repair\.txt/);
    assert.equal(seen.length, 2);
  });

  it("refuses rather than overwrite a branch that moved under it", async () => {
    const { remote, copy } = remoteAndCopy();
    featureBranch(copy, "issue/fake-42", "work.txt");
    const seen: SubmissionRequest[] = [];
    const authority = authorityOn(copy, seen);
    await authority.submit(offer());

    // Somebody else added to the same branch. Integrator only ever adds
    // history, so this is not a case this system can produce — which is exactly
    // why it must not be pushed through.
    const other = otherWorkingCopy(remote, "issue/fake-42");
    commit(other, "theirs.txt", "not ours\n");
    git(other, ["push", "-q", "origin", "issue/fake-42"]);
    commit(copy, "ours.txt", "ours\n");

    const result = await authority.submit(offer());

    assert.equal(result.outcome, "refused");
    assert.equal(seen.length, 1, "nothing is offered when nothing was published");
    assert.match(git(remote, ["log", "--oneline", "issue/fake-42"]), /theirs\.txt/);
    assert.doesNotMatch(git(remote, ["log", "--oneline", "issue/fake-42"]), /ours\.txt/);
  });

  it("says git's refusal in English whatever the machine speaks", async () => {
    // The reason is posted on the tracker; seen live in French on a French
    // machine. On a machine with no French locale git speaks English anyway,
    // and this passes without proving anything there.
    const { copy } = remoteAndCopy();
    const seen: SubmissionRequest[] = [];
    const french = { LC_ALL: "fr_FR.UTF-8", LANG: "fr_FR.UTF-8", LANGUAGE: "fr" };

    // No branch by the Child's name: git refuses the refspec.
    const result = await authorityOn(copy, seen, undefined, french).submit(offer());

    assert.ok(result.outcome === "refused", JSON.stringify(result));
    assert.match(result.reason, /does not match any/);
    assert.doesNotMatch(result.reason, /ne correspond|erreur/);
  });

  it("refuses a work line that is not a git repository", async () => {
    const copy = mkdtempSync(join(tmpdir(), "authority-plain-"));
    const seen: SubmissionRequest[] = [];
    const result = await authorityOn(copy, seen).submit(offer());
    assert.equal(result.outcome, "refused");
    assert.equal(seen.length, 0);
  });
});

describe("bringing the work line copy up to date", () => {
  it("fast-forwards to what the Authority holds", () => {
    const { remote, copy } = remoteAndCopy();
    const other = otherWorkingCopy(remote, TARGET);
    commit(other, "merged.txt", "folded\n");
    git(other, ["push", "-q", "origin", TARGET]);

    const refreshed = refreshOn(copy);

    assert.equal(refreshed.ok, true, refreshed.detail);
    // Left behind, the next Isolation starts from a version of the work line
    // that no longer exists.
    assert.match(git(copy, ["log", "--oneline", TARGET]), /merged\.txt/);
  });

  it("says so rather than rewrite a work line that diverged", () => {
    const { remote, copy } = remoteAndCopy();
    const other = otherWorkingCopy(remote, TARGET);
    commit(other, "theirs.txt", "theirs\n");
    git(other, ["push", "-q", "origin", TARGET]);
    commit(copy, "ours.txt", "ours\n");

    const refreshed = refreshOn(copy);

    assert.equal(refreshed.ok, false);
    // A person reading this needs the way out, not git's words alone.
    assert.match(refreshed.detail ?? "", new RegExp(`has diverged from origin/${TARGET}`));
    // macOS hands the temp dir back under /private; the path is real either way.
    assert.match(refreshed.detail ?? "", new RegExp(`git -C \\S+ reset --hard origin/${TARGET}`));
    assert.match(refreshed.detail ?? "", /delete the directory/);
    assert.match(git(copy, ["log", "--oneline", TARGET]), /ours\.txt/);
  });

  it("says git's words in English whatever the machine speaks", () => {
    const { copy } = remoteAndCopy();
    const refreshed = refreshWorkLine({
      workLineStable: copy,
      workLineTarget: "nowhere",
      refreshArgv: ["node", GIT_REFRESHER],
      timeoutMs: 60_000,
      env: { LC_ALL: "fr_FR.UTF-8", LANG: "fr_FR.UTF-8", LANGUAGE: "fr" },
    });
    assert.equal(refreshed.ok, false);
    assert.match(refreshed.detail ?? "", /couldn't find remote ref nowhere/);
    assert.doesNotMatch(refreshed.detail ?? "", /impossible|distante/);
  });

  it("has nothing to do when the work line is a plain directory", () => {
    const copy = mkdtempSync(join(tmpdir(), "authority-plain-"));
    assert.deepEqual(refreshOn(copy), {
      ok: true,
    });
  });
});
