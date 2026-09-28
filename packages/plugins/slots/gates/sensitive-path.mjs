#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { emitVerdict, GATE_FLAGS, ownArgv, pathMatchesGlob } from "@bluewombat/slot-kit";

// Fail-retryable when the workspace changed a path matching a glob.
// Remaining argv after Implementer's flags are the globs.
//
// Only paths a fold can carry out of the workspace: tracked ones, and new ones
// .gitignore does not exclude. What a Builder's own install left under an
// ignored directory (a dependency's own .github/) stays in the workspace, so
// changing it is not a change to guard.

const cwd = process.cwd();
const globs = ownArgv(process.argv, GATE_FLAGS).filter((token) => token.length > 0);

if (globs.length === 0) {
  emitVerdict("fail-blocking", "sensitive-path needs at least one glob.");
  process.exit(0);
}

if (git(cwd, ["rev-parse", "--is-inside-work-tree"]).stdout.trim() !== "true") {
  emitVerdict("fail-blocking", "sensitive-path needs a git workspace.");
  process.exit(0);
}

const hit = new Set();

const listed = git(cwd, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
if (listed.status !== 0) {
  emitVerdict("fail-blocking", `sensitive-path cannot list the workspace: ${listed.stderr.trim()}`);
  process.exit(0);
}
for (const posix of new Set(listed.stdout.split("\0").filter(Boolean))) {
  const file = join(cwd, posix);
  // A tracked path gone from disk is a deletion, read below.
  if (!matchesAny(posix, globs) || !existsSync(file)) {
    continue;
  }
  const onDisk = readFileSync(file);
  const atHead = blobAtHead(cwd, posix);
  if (atHead === null || Buffer.compare(onDisk, atHead) !== 0) {
    hit.add(posix);
  }
}

const deleted = git(cwd, ["diff", "--name-only", "--diff-filter=D", "HEAD"]);
if (deleted.status === 0) {
  for (const file of deleted.stdout.split("\n").filter(Boolean)) {
    if (matchesAny(file.replaceAll("\\", "/"), globs)) {
      hit.add(file);
    }
  }
}

if (hit.size > 0) {
  emitVerdict("fail-retryable", `Sensitive paths changed:\n${[...hit].sort().join("\n")}`);
  process.exit(0);
}

emitVerdict("pass");

/**
 * @param {string} path
 * @param {readonly string[]} patterns
 */
function matchesAny(path, patterns) {
  return patterns.some((pattern) => pathMatchesGlob(path, pattern));
}

/**
 * @param {string} workspace
 * @param {string} path
 */
function blobAtHead(workspace, path) {
  const result = spawnSync("git", ["-C", workspace, "show", `HEAD:${path}`]);
  if (result.status !== 0) {
    return null;
  }
  return result.stdout;
}

/**
 * @param {string} workspace
 * @param {string[]} args
 */
function git(workspace, args) {
  return spawnSync("git", ["-C", workspace, ...args], { encoding: "utf8" });
}
