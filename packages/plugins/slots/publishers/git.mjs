#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  emitPublication,
  emitPublishRefusal,
  ownArgv,
  PUBLISHER_FLAGS,
  take,
  writeDiagnostic,
} from "@bluewombat/slot-kit";

// Put the ticket's work where the Authority can read it, by pushing the name
// Isolator gave it to the work line's own remote.
//
// What is pushed is the Ticket's result, not what its workspace went through:
// the workspace is snapshotted again at every integration, and a blob that was
// added and removed along the way (an install, a build) would travel with its
// history and make a pack no host accepts. So one commit is made from the
// branch's tree, on top of the work line's tip, and that commit is pushed.
// A resubmission continues what this slot published before, which the work line
// remembers, so the push stays a fast-forward.
//
// A plain push, and no force of any kind. A rejection means the name moved
// under us — someone else's commit, or a rewrite — and that is exactly the
// case worth refusing rather than overwriting: a branch this slot did not
// publish is never built upon.
//
// The remote is `origin`, and there is no option for it: Host reads the work
// line back from `origin` after the Authority folds, with no way to learn what
// this slot was told. An option that publishes to one remote while the refresh
// reads another is a trap, so it waits for that half to become a slot too.
//
// Runs in the work line. mason appends --id, --ref and --target.

const cwd = process.cwd();
const tokens = ownArgv(process.argv, PUBLISHER_FLAGS);
if (tokens.length > 0) {
  emitPublishRefusal(`git publisher takes no option, got "${tokens[0]}".`);
  process.exit(0);
}
const remote = "origin";

const ref = take(process.argv, "--ref");
if (ref === undefined || ref.trim().length === 0) {
  emitPublishRefusal("git publisher was given no --ref to publish.");
  process.exit(0);
}

if (!existsSync(join(cwd, ".git"))) {
  emitPublishRefusal("A Submission needs a git work line; this one has no .git.");
  process.exit(0);
}

// C locale: git's words become the refusal a team reads on the tracker, and a
// machine's own language would put French or German in an English thread.
const env = { ...process.env, LC_ALL: "C" };
/** @param {...string} args */
const git = (...args) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env });
/** @param {{ stderr?: string | null, stdout?: string | null }} run */
const text = (run) => `${run.stderr ?? ""}${run.stdout ?? ""}`.trim().slice(-1000);

/**
 * Runs git; a git that cannot run at all ends the slot, anything else is the caller's to read.
 * @param {...string} args
 */
function run(...args) {
  const done = git(...args);
  if (done.error !== undefined) {
    writeDiagnostic(`git publisher cannot run git: ${done.error.message}\n`);
    process.exit(1);
  }
  return done;
}

/**
 * @param {string} what
 * @param {{ stderr?: string | null, stdout?: string | null }} [done]
 * @returns {never}
 */
function refuse(what, done) {
  emitPublishRefusal(
    `Could not publish ${ref}: ${what}${done === undefined ? "" : `: ${text(done)}`}`,
  );
  process.exit(0);
}

const target = take(process.argv, "--target");
const id = take(process.argv, "--id");
if (target === undefined || target.trim().length === 0) {
  refuse("it was given no --target to build on");
}

// The line's tip, as the remote holds it: what the Submission is a change to.
const fetched = run("fetch", "--quiet", remote, target);
if (fetched.status !== 0) {
  refuse(`cannot read ${target} from ${remote}`, fetched);
}
const tip = run("rev-parse", "FETCH_HEAD");
const tipOid = tip.stdout.trim();
if (tip.status !== 0 || tipOid.length === 0) {
  refuse(`cannot read ${target}`, tip);
}
const tree = run("rev-parse", `${ref}^{tree}`);
if (tree.status !== 0) {
  refuse(`${ref} is not a branch of this work line`, tree);
}
const treeOid = tree.stdout.trim();

// What this slot published before: the work line keeps it under `refs/published/`.
// A name that holds anything else moved under us, and is left for the push to
// reject.
const recordName = `refs/published/${ref}`;
let before;
const recorded = run("rev-parse", "--verify", "--quiet", recordName).stdout.trim();
const remoteRef = run("ls-remote", remote, `refs/heads/${ref}`);
const remoteOid = remoteRef.stdout.trim().split(/\s+/)[0] ?? "";
if (recorded.length > 0 && remoteRef.status === 0 && remoteOid === recorded) {
  before = recorded;
}

// Nothing new: the same tree on the same line, already there.
if (
  before !== undefined &&
  run("rev-parse", `${before}^{tree}`).stdout.trim() === treeOid &&
  run("merge-base", "--is-ancestor", tipOid, before).status === 0
) {
  emitPublication(ref);
  process.exit(0);
}

const parents = [...new Set([before, tipOid].filter((oid) => oid !== undefined))];
const made = run(
  "commit-tree",
  treeOid,
  ...parents.flatMap((oid) => ["-p", oid]),
  "-m",
  `Submission of ${id ?? ref}`,
);
const commit = made.stdout.trim();
if (made.status !== 0 || commit.length === 0) {
  refuse("cannot make the commit", made);
}

const pushed = run("push", remote, `${commit}:refs/heads/${ref}`);
if (pushed.status !== 0) {
  refuse("the push was refused", pushed);
}
run("update-ref", recordName, commit);

emitPublication(ref);
