#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { emitVerdict, GATE_FLAGS, ownArgv } from "@bluewombat/slot-kit";

// No argv of its own: a path this workspace's .gitignore excludes has no
// business being tracked, whichever fold put it there.
//
// A Builder that installs dependencies or builds generated output to verify
// its own work (npm install, npm run build) leaves that output on disk. A
// fold that snapshots the whole working tree can catch it in the commit it
// produces even though .gitignore says otherwise. This runs at the assembly
// stage, against the assembled feature, where that commit already exists —
// a unit's own workspace has nothing committed yet for `git ls-files` to see.

const cwd = process.cwd();
const tokens = ownArgv(process.argv, GATE_FLAGS);

if (tokens.length > 0) {
  emitVerdict("fail-blocking", `gitignore-leak takes no option, got "${tokens[0]}".`);
  process.exit(0);
}

if (git(["rev-parse", "--is-inside-work-tree"]).stdout.trim() !== "true") {
  emitVerdict("fail-blocking", "gitignore-leak needs a git workspace.");
  process.exit(0);
}

// Tracked (-c) and ignored (-i) at once: git's own way of finding a path that
// is both. --exclude-standard reads .gitignore the way any git command would.
const listed = git(["ls-files", "-ci", "--exclude-standard"]);
if (listed.status !== 0) {
  emitVerdict("fail-blocking", `gitignore-leak cannot read git ls-files: ${listed.stderr.trim()}`);
  process.exit(0);
}

const leaked = listed.stdout.split("\n").filter(Boolean);
if (leaked.length > 0) {
  const shown = leaked.slice(0, 50);
  const rest = leaked.length - shown.length;
  const list = rest > 0 ? [...shown, `… and ${rest} more`] : shown;
  emitVerdict(
    "fail-retryable",
    `Tracked paths this workspace's own .gitignore excludes:\n${list.join("\n")}`,
  );
  process.exit(0);
}

emitVerdict("pass");

/** @param {string[]} args */
function git(args) {
  return spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}
