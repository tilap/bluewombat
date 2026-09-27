#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { emitVerdict, GATE_FLAGS, ownArgv, stageOf } from "@bluewombat/slot-kit";

// Fail-retryable when the feature's commits add a path the workspace's own
// .gitignore excludes — a Builder's node_modules/, a build's dist/, a generated
// file — so it would ship in the Submission.
//
// --base REF (required): the work line the feature is offered to. Only what the
// feature adds since it left that line is judged, in what is committed: a path
// tracked on purpose before the feature began is not this feature's leak, and
// a removal staged but not committed has not removed anything yet.
//
// A unit only: nothing. A Subtask's work is uncommitted until a fold records it,
// so there is no commit of its own here to judge.

const cwd = process.cwd();
const tokens = ownArgv(process.argv, GATE_FLAGS);

let base;
for (let i = 0; i < tokens.length; i++) {
  const token = tokens[i];
  if (token === "--base") {
    const value = tokens[i + 1];
    if (value === undefined || value.startsWith("-")) {
      emitVerdict("fail-blocking", "gitignore-leak needs a ref after --base.");
      process.exit(0);
    }
    base = value;
    i += 1;
    continue;
  }
  emitVerdict("fail-blocking", `gitignore-leak does not take "${token}". Use --base <ref>.`);
  process.exit(0);
}

if (base === undefined) {
  emitVerdict(
    "fail-blocking",
    "gitignore-leak needs --base <ref>: the work line the feature is offered to.",
  );
  process.exit(0);
}

if (git(["rev-parse", "--is-inside-work-tree"]).stdout.trim() !== "true") {
  emitVerdict("fail-blocking", "gitignore-leak needs a git workspace.");
  process.exit(0);
}

if (stageOf(process.argv) !== "assembly") {
  emitVerdict("pass");
  process.exit(0);
}

if (git(["rev-parse", "--verify", "--quiet", `${base}^{commit}`]).status !== 0) {
  emitVerdict("fail-blocking", `gitignore-leak cannot find --base "${base}" in this workspace.`);
  process.exit(0);
}

// --no-renames: a path moved under an ignored directory shows as added there.
const added = git([
  "diff",
  "--name-only",
  "--no-renames",
  "--diff-filter=A",
  "-z",
  `${base}...HEAD`,
]);
if (added.status !== 0) {
  emitVerdict(
    "fail-blocking",
    `gitignore-leak cannot diff HEAD against "${base}": ${added.stderr.trim()}`,
  );
  process.exit(0);
}
if (added.stdout.length === 0) {
  emitVerdict("pass");
  process.exit(0);
}

// --no-index: these paths are tracked, and the question is whether the
// patterns match them, not whether git would still pick them up.
const ignored = spawnSync("git", ["-C", cwd, "check-ignore", "--no-index", "--stdin", "-z"], {
  input: added.stdout,
  encoding: "utf8",
});
// 0: some match; 1: none does; anything else is git failing.
if (ignored.status === 1) {
  emitVerdict("pass");
  process.exit(0);
}
if (ignored.status !== 0) {
  emitVerdict(
    "fail-blocking",
    `gitignore-leak cannot run git check-ignore: ${ignored.stderr.trim()}`,
  );
  process.exit(0);
}

const leaked = ignored.stdout.split("\0").filter(Boolean);
const shown = leaked.slice(0, 50);
const rest = leaked.length - shown.length;
emitVerdict(
  "fail-retryable",
  [
    `These paths are committed on top of ${base}, and this workspace's .gitignore excludes them.`,
    "Take them out of the commit with git rm -r --cached <path> and keep the files. If the",
    "feature does mean to track one, change .gitignore so it no longer excludes it:",
    ...shown,
    ...(rest > 0 ? [`… and ${rest} more`] : []),
  ].join("\n"),
);

/** @param {string[]} args */
function git(args) {
  return spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}
