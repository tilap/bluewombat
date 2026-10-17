#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  emitVerdict,
  GATE_FLAGS,
  listOption,
  ownArgv,
  parseOptions,
  pathMatchesGlob,
} from "@bluewombat/slot-kit";

// Fail-blocking when the workspace holds any change at all: a modified file, a
// deleted one, a new one that .gitignore does not exclude.
//
// For a pass that must not write — `assembly.validate`, a read-only review. Its
// other Gates look at parts (`sensitive-path` at some globs, `parent-clean` at the
// Parent), so a reviewer that edits a file nobody named goes unseen. This one
// watches all of them.
//
// Run it where the workspace is committed and clean: after the align, every
// change of the ticket is in a commit, so whatever `git status` shows was
// written since. A check run before it can leave files of its own (a coverage
// report, a build directory) when the Project does not ignore them; name those
// with --allow GLOB (repeatable) instead of loosening the Gate.
//
// Blocking, not retryable: the review is not something another round repairs,
// and what it wrote would be committed by the next align. A person looks.

const cwd = process.cwd();
const parsed = parseOptions(
  ownArgv(process.argv, GATE_FLAGS),
  { "--allow": { many: true } },
  "workspace-unchanged",
);
if (!parsed.ok) {
  emitVerdict("fail-blocking", `${parsed.reason} Use --allow GLOB for a path that may change.`);
  process.exit(0);
}
const allowed = listOption(parsed.values, "allow");

if (git(["rev-parse", "--is-inside-work-tree"]).stdout.trim() !== "true") {
  emitVerdict("fail-blocking", "workspace-unchanged needs a git workspace.");
  process.exit(0);
}

const status = git(["status", "--porcelain", "-z", "-uall"]);
if (status.status !== 0) {
  emitVerdict(
    "fail-blocking",
    `workspace-unchanged cannot read git status: ${status.stderr.trim()}`,
  );
  process.exit(0);
}

// `XY path`, NUL-separated; a rename carries its origin as one more entry.
const changed = [];
const entries = status.stdout.split("\0").filter(Boolean);
for (let i = 0; i < entries.length; i++) {
  const entry = entries[i] ?? "";
  const path = entry.slice(3);
  if (entry[0] === "R" || entry[1] === "R") {
    i += 1;
  }
  if (!allowed.some((glob) => pathMatchesGlob(path, glob))) {
    changed.push(path);
  }
}

if (changed.length === 0) {
  emitVerdict("pass");
  process.exit(0);
}

const shown = changed.slice(0, 50);
const rest = changed.length - shown.length;
emitVerdict(
  "fail-blocking",
  [
    "This pass is read-only and it changed the workspace. What it wrote would be",
    "committed by the next align, so nothing is repaired automatically:",
    ...shown,
    ...(rest > 0 ? [`… and ${rest} more`] : []),
    "Look at the changes (git status, git diff), undo them, and run the ticket again.",
  ].join("\n"),
);

/** @param {string[]} args */
function git(args) {
  return spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}
