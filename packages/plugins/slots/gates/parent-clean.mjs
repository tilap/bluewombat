#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { emitVerdict, GATE_FLAGS, ownArgv } from "@bluewombat/slot-kit";

// Parent working files must not change during the Attempt.
// --parent DIR (repeatable). Other git worktrees of this Child are included.

const cwd = resolve(process.cwd());
const tokens = ownArgv(process.argv, GATE_FLAGS);
const named = [];

for (let i = 0; i < tokens.length; i++) {
  const token = tokens[i];
  if (token === "--parent") {
    const value = tokens[i + 1];
    if (value === undefined || value.startsWith("-")) {
      emitVerdict("fail-blocking", "parent-clean needs a directory after --parent.");
      process.exit(0);
    }
    named.push(resolve(cwd, value));
    i += 1;
    continue;
  }
  emitVerdict("fail-blocking", `parent-clean does not take "${token}". Use --parent <dir>.`);
  process.exit(0);
}

const parents = [...named];
for (const worktree of otherWorktrees(cwd)) {
  if (!parents.includes(worktree)) {
    parents.push(worktree);
  }
}

if (parents.length === 0) {
  emitVerdict(
    "fail-blocking",
    "parent-clean needs --parent <dir>, or a git worktree Child so it can see the other trees.",
  );
  process.exit(0);
}

const leaked = [];
for (const parent of parents) {
  if (parent === cwd) {
    continue;
  }
  if (!existsSync(parent) || !statSync(parent).isDirectory()) {
    // A directory that was named on the command line and is not there is a
    // configuration error. A worktree git still lists after its directory went
    // away is git bookkeeping: it holds no working file, so it can leak none.
    if (named.includes(parent)) {
      emitVerdict("fail-blocking", `parent-clean --parent is not a directory: ${parent}`);
      process.exit(0);
    }
    continue;
  }
  leaked.push(...leaksIn(parent, cwd));
}

if (leaked.length > 0) {
  emitVerdict("fail-blocking", `Parent working files changed:\n${leaked.join("\n")}`);
  process.exit(0);
}

emitVerdict("pass");

/** Other worktrees of this repository, minus the ones git has marked prunable. */
/** @param {string} workspace @returns {string[]} */
function otherWorktrees(workspace) {
  const result = git(workspace, ["worktree", "list", "--porcelain"]);
  if (result.status !== 0) {
    return [];
  }
  const trees = [];
  for (const record of result.stdout.split("\n\n")) {
    const lines = record.split("\n");
    const entry = lines.find((line) => line.startsWith("worktree "));
    if (entry === undefined || lines.some((line) => line.startsWith("prunable"))) {
      continue;
    }
    const path = resolve(entry.slice("worktree ".length));
    if (path !== workspace) {
      trees.push(path);
    }
  }
  return trees;
}

/**
 * @param {string} parent
 * @param {string} workspace
 * @returns {string[]}
 */
function leaksIn(parent, workspace) {
  if (existsSync(join(parent, ".git"))) {
    const status = git(parent, ["status", "--porcelain", "-uall"]);
    if (status.status !== 0) {
      return [`${parent}: git status failed`];
    }
    const lines = status.stdout
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean);
    return lines.map((line) => `${relative(workspace, parent) || parent}: ${line}`);
  }
  const referenceMs = referenceTime(workspace);
  /** @type {string[]} */
  const dirty = [];
  walkFiles(parent, (file) => {
    if (statSync(file).mtimeMs > referenceMs) {
      dirty.push(`${relative(workspace, parent) || parent}: ${relative(parent, file)}`);
    }
  });
  return dirty;
}

/** @param {string} workspace */
function referenceTime(workspace) {
  const gitFile = join(workspace, ".git");
  if (existsSync(gitFile)) {
    return statSync(gitFile).mtimeMs;
  }
  let oldest = Number.POSITIVE_INFINITY;
  walkFiles(workspace, (file) => {
    oldest = Math.min(oldest, statSync(file).mtimeMs);
  });
  if (Number.isFinite(oldest)) {
    return oldest;
  }
  return statSync(workspace).mtimeMs;
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
 * @param {string} cwd
 * @param {string[]} args
 */
function git(cwd, args) {
  return spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}
