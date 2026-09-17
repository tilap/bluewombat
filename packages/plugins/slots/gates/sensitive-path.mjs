#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { emitVerdict, GATE_FLAGS, ownArgv, pathMatchesGlob } from "@bluewombat/slot-kit";

// Fail-retryable when the workspace changed a path matching a glob.
// Remaining argv after Implementer's flags are the globs.

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

walkFiles(cwd, (file) => {
  const posix = relative(cwd, file).replaceAll("\\", "/");
  if (!matchesAny(posix, globs)) {
    return;
  }
  const onDisk = readFileSync(file);
  const atHead = blobAtHead(cwd, posix);
  if (atHead === null || Buffer.compare(onDisk, atHead) !== 0) {
    hit.add(posix);
  }
});

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
 * @param {string} dir
 * @param {(file: string) => void} visit
 */
function walkFiles(dir, visit) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === ".git") {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, visit);
      continue;
    }
    if (entry.isFile()) {
      visit(full);
    }
  }
}

/**
 * @param {string} workspace
 * @param {string[]} args
 */
function git(workspace, args) {
  return spawnSync("git", ["-C", workspace, ...args], { encoding: "utf8" });
}
