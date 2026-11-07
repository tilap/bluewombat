#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { emitVerdict, GATE_FLAGS, ownArgv } from "@bluewombat/slot-kit";

// Parent working files must not change during the Attempt.
// --parent DIR (repeatable): always watched.
// The main worktree of this Child's repository is watched too. Its other linked
// worktrees are sibling Children (parallel tickets, escalated leftovers): they are
// legitimately dirty, so they are ignored unless --siblings is given.
// A watched git tree only counts files modified after this Child was created, so
// work that was already there (a human's uncommitted edit) is not a leak.

const cwd = resolve(process.cwd());
const tokens = ownArgv(process.argv, GATE_FLAGS);
const named = [];
let withSiblings = false;

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
  if (token === "--siblings") {
    withSiblings = true;
    continue;
  }
  emitVerdict(
    "fail-blocking",
    `parent-clean does not take "${token}". Use --parent <dir> or --siblings.`,
  );
  process.exit(0);
}

const parents = [...named];
for (const worktree of otherWorktrees(cwd, withSiblings)) {
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

/**
 * The main worktree of this repository (git lists it first), plus the other linked
 * worktrees when `siblings` is set. Worktrees git has marked prunable are left out.
 */
/** @param {string} workspace @param {boolean} siblings @returns {string[]} */
function otherWorktrees(workspace, siblings) {
  const result = git(workspace, ["worktree", "list", "--porcelain"]);
  if (result.status !== 0) {
    return [];
  }
  const trees = [];
  const records = result.stdout.split("\n\n");
  for (const [index, record] of records.entries()) {
    if (index > 0 && !siblings) {
      break;
    }
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
    const referenceMs = referenceTime(workspace);
    const lines = status.stdout
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .filter((line) => !untouchedSince(parent, line, referenceMs));
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

/**
 * A status line whose file still exists and was last written before the Child was
 * created is older than the Attempt. A deletion has no date and always counts.
 * @param {string} parent
 * @param {string} line
 * @param {number} referenceMs
 */
function untouchedSince(parent, line, referenceMs) {
  const path = line.slice(3).split(" -> ").at(-1) ?? "";
  try {
    return statSync(join(parent, path.replace(/^"|"$/g, ""))).mtimeMs <= referenceMs;
  } catch {
    return false;
  }
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
