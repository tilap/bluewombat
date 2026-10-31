#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  emitVerdict,
  GATE_FLAGS,
  listOption,
  ownArgv,
  parseOptions,
  pathMatchesGlob,
  stageOf,
  take,
  textOption,
} from "@bluewombat/slot-kit";

// What the work changed since the line it is offered to, judged by path.
//
// The base is the work line the workspace was cut from. Without --base it is the
// branch checked out in the main worktree of the repository the workspace belongs
// to: Isolation makes every workspace a worktree of the work line's copy, and Host
// keeps that copy on the line the work lands on (a Feature's own line while a
// Feature is open), so the answer follows the line. A branch named by hand
// (`--base main`) is the copy's local branch and is only as fresh as the last
// time something moved it; Host moves the Feature's line, not `main`.
//
// The changed set is what differs between the base and the workspace: the commits
// since the workspace left it (`BASE...HEAD`) and whatever is on disk and not yet
// committed (a fold can carry it out, so it counts; an ignored path does not).
// Unlike a Gate that compares the disk to the last commit, it still sees the work
// once it is committed, so it answers at the unit, the ticket and the recheck
// after the align (`--stage assembly`).
//
// At `--stage feature` there is no base to derive: the Feature's workspace is its
// line with the target merged in, so the line would show the target's work. Name
// the target with --base there.
//
//   --base REF       optional. The ref to compare with, instead of the main
//                    worktree's branch.
//
// Two ways to use the changed set, alone or together:
//
//   --deny GLOB      repeatable. fail-retryable when a changed path matches:
//                    "this must not be touched".
//   --when GLOB      repeatable, with --run. When a changed path matches, run
//                    CMD with project-checks (shell, output cleaned, the Gate's
//                    ceiling honoured) and answer as it does: "if this changed,
//                    this must hold". When nothing matches, pass without running it.
//   --run CMD        MASON_BASE holds the base; MASON_CHANGED_FILES holds the
//                    changed paths, one per line, so CMD can narrow itself to them.
//
// `*` is one path segment, `**` any depth.

const cwd = process.cwd();
const projectChecks = join(dirname(fileURLToPath(import.meta.url)), "project-checks.mjs");

const parsed = parseOptions(
  ownArgv(process.argv, GATE_FLAGS),
  { "--base": {}, "--deny": { many: true }, "--when": { many: true }, "--run": {} },
  "base-diff",
);
if (!parsed.ok) {
  emitVerdict("fail-blocking", parsed.reason);
  process.exit(0);
}
const explicitBase = textOption(parsed.values, "base");
const deny = listOption(parsed.values, "deny");
const when = listOption(parsed.values, "when");
const command = textOption(parsed.values, "run");

if (explicitBase?.startsWith("-")) {
  emitVerdict("fail-blocking", `base-diff cannot take "${explicitBase}" as a base.`);
  process.exit(0);
}
if (deny.length === 0 && when.length === 0 && command === undefined) {
  emitVerdict(
    "fail-blocking",
    "base-diff needs at least one --deny GLOB, or --when GLOB with --run CMD.",
  );
  process.exit(0);
}
if (when.length > 0 !== (command !== undefined)) {
  emitVerdict(
    "fail-blocking",
    "base-diff takes --when and --run together: a condition, and what to run on it.",
  );
  process.exit(0);
}

if (git(["rev-parse", "--is-inside-work-tree"]).stdout.trim() !== "true") {
  emitVerdict("fail-blocking", "base-diff needs a git workspace.");
  process.exit(0);
}

const base = explicitBase ?? deriveBase();
if (base === undefined) {
  process.exit(0);
}
if (git(["rev-parse", "--verify", "--quiet", `${base}^{commit}`]).status !== 0) {
  emitVerdict("fail-blocking", `base-diff cannot find the base "${base}" in this workspace.`);
  process.exit(0);
}

const changed = changedPaths();
if (changed === undefined) {
  process.exit(0);
}

if (deny.length > 0) {
  const hit = changed.filter((path) => matchesAny(path, deny));
  if (hit.length > 0) {
    emitVerdict(
      "fail-retryable",
      `Paths changed since ${base} that this work may not touch (${deny.join(", ")}):\n${hit.join("\n")}`,
    );
    process.exit(0);
  }
}

if (command !== undefined && changed.some((path) => matchesAny(path, when))) {
  runCondition(command);
} else {
  emitVerdict("pass");
}

/**
 * The branch checked out in the main worktree: the line this workspace's work
 * lands on. Nothing when there is none to name; the verdict is then already out.
 * @returns {string | undefined}
 */
function deriveBase() {
  if (stageOf(process.argv) === "feature") {
    emitVerdict(
      "fail-blocking",
      "base-diff cannot derive a base at the feature stage: the Feature's workspace is its line with the target merged in, so the line would show the target's work, not the Feature's. Name the target with --base.",
    );
    return undefined;
  }
  const listed = git(["worktree", "list", "--porcelain"]);
  if (listed.status !== 0) {
    emitVerdict("fail-blocking", `base-diff cannot list the worktrees: ${listed.stderr.trim()}`);
    return undefined;
  }
  // The first entry is the main worktree.
  const main = listed.stdout.split("\n\n")[0] ?? "";
  const mainPath = /^worktree (.+)$/m.exec(main)?.[1];
  const branch = /^branch refs\/heads\/(.+)$/m.exec(main)?.[1];
  const top = git(["rev-parse", "--show-toplevel"]).stdout.trim();
  if (mainPath === undefined || top.length === 0) {
    emitVerdict(
      "fail-blocking",
      "base-diff cannot tell which worktree is the main one. Name the base with --base.",
    );
    return undefined;
  }
  if (sameDirectory(mainPath, top)) {
    emitVerdict(
      "fail-blocking",
      "base-diff has no base to derive: this workspace is the main worktree itself, not a worktree of a work line. Name the base with --base.",
    );
    return undefined;
  }
  if (branch === undefined) {
    emitVerdict(
      "fail-blocking",
      `base-diff has no base to derive: the main worktree (${mainPath}) has no branch checked out. Name the base with --base.`,
    );
    return undefined;
  }
  return `refs/heads/${branch}`;
}

/**
 * Runs the --run command through project-checks, so it is cleaned, bounded and
 * classified the way every command of the Project is, and relays its verdict.
 * @param {string} cmd
 */
function runCondition(cmd) {
  const flags = ["--cmd", cmd];
  const ceiling = take(process.argv, "--timeout-ms");
  if (ceiling !== undefined) {
    flags.push("--timeout-ms", ceiling);
  }
  const result = spawnSync(process.execPath, [projectChecks, ...flags], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, MASON_BASE: base, MASON_CHANGED_FILES: (changed ?? []).join("\n") },
  });
  const line = (result.stdout ?? "").trim().split("\n").filter(Boolean).at(-1);
  /** @type {{ verdict?: string; report?: string } | undefined} */
  let answer;
  try {
    answer = line === undefined ? undefined : JSON.parse(line);
  } catch {
    answer = undefined;
  }
  if (answer?.verdict === "pass") {
    emitVerdict("pass");
    return;
  }
  if (answer?.verdict === "fail-retryable" || answer?.verdict === "fail-blocking") {
    const lead = `Paths matching ${when.join(", ")} changed since ${base}. `;
    emitVerdict(answer.verdict, `${lead}${answer.report ?? ""}`.trim());
    return;
  }
  emitVerdict(
    "fail-blocking",
    `base-diff could not read the answer of "${cmd}": ${(result.stderr ?? "").trim().slice(-2_000) || "no output"}`,
  );
}

/**
 * Every path that differs from the base, committed or not, sorted. Nothing when
 * git could not say: the verdict is already out.
 * @returns {string[] | undefined}
 */
function changedPaths() {
  // --no-renames: a move is a removal and an addition, so the old path counts too.
  const committed = git(["diff", "--name-only", "--no-renames", "-z", `${base}...HEAD`]);
  if (committed.status !== 0) {
    emitVerdict(
      "fail-blocking",
      `base-diff cannot diff HEAD against "${base}": ${committed.stderr.trim()}`,
    );
    return undefined;
  }
  const status = git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (status.status !== 0) {
    emitVerdict("fail-blocking", `base-diff cannot read the workspace: ${status.stderr.trim()}`);
    return undefined;
  }
  const paths = new Set(committed.stdout.split("\0").filter(Boolean));
  const fields = status.stdout.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i] ?? "";
    if (entry.length < 4) {
      continue;
    }
    paths.add(entry.slice(3));
    // A rename or a copy carries the old path in the next field.
    if (entry[0] === "R" || entry[0] === "C") {
      const old = fields[++i];
      if (old !== undefined && old.length > 0) {
        paths.add(old);
      }
    }
  }
  return [...paths].map((path) => path.replaceAll("\\", "/")).sort();
}

/**
 * @param {string} a
 * @param {string} b
 */
function sameDirectory(a, b) {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return a === b;
  }
}

/**
 * @param {string} path
 * @param {readonly string[]} patterns
 */
function matchesAny(path, patterns) {
  return patterns.some((pattern) => pathMatchesGlob(path, pattern));
}

/** @param {string[]} args */
function git(args) {
  return spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}
