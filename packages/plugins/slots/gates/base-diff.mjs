#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  emitVerdict,
  GATE_FLAGS,
  listOption,
  ownArgv,
  parseOptions,
  pathMatchesGlob,
  textOption,
} from "@bluewombat/slot-kit";

// What the work changed since the line it is offered to, judged by path.
//
// --base REF (required): the work line. The changed set is what differs between
// REF and the workspace: the commits since the workspace left REF
// (`REF...HEAD`) and whatever is on disk and not yet committed (a fold can carry
// it out, so it counts; an ignored path does not). Unlike a Gate that compares
// the disk to the last commit, it still sees the work once it is committed, so
// it answers at every stage: a unit, a ticket, the recheck after the align, a
// Feature.
//
// Two ways to use the changed set, alone or together:
//
//   --deny GLOB      repeatable. fail-retryable when a changed path matches:
//                    "this must not be touched".
//   --when GLOB      repeatable, with --run. When a changed path matches, run
//                    CMD through the shell in the workspace and answer on its
//                    exit code, like project-checks: "if this changed, this
//                    must hold". When nothing matches, pass without running it.
//   --run CMD        MASON_BASE holds REF; MASON_CHANGED_FILES holds the changed
//                    paths, one per line, so CMD can narrow itself to them.
//
// `*` is one path segment, `**` any depth.

const cwd = process.cwd();
const TAIL_BYTES = 8_000;

const parsed = parseOptions(
  ownArgv(process.argv, GATE_FLAGS),
  { "--base": {}, "--deny": { many: true }, "--when": { many: true }, "--run": {} },
  "base-diff",
);
if (!parsed.ok) {
  emitVerdict("fail-blocking", parsed.reason);
  process.exit(0);
}
const base = textOption(parsed.values, "base");
const deny = listOption(parsed.values, "deny");
const when = listOption(parsed.values, "when");
const command = textOption(parsed.values, "run");

if (base === undefined || base.startsWith("-")) {
  emitVerdict(
    "fail-blocking",
    "base-diff needs --base <ref>: the work line the work is offered to.",
  );
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
if (git(["rev-parse", "--verify", "--quiet", `${base}^{commit}`]).status !== 0) {
  emitVerdict("fail-blocking", `base-diff cannot find --base "${base}" in this workspace.`);
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
  const result = spawnSync("sh", ["-c", command], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      CI: "true",
      MASON_BASE: base,
      MASON_CHANGED_FILES: changed.join("\n"),
    },
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().slice(-TAIL_BYTES);
  if (result.error !== undefined) {
    emitVerdict("fail-blocking", `base-diff cannot start "${command}": ${result.error.message}`);
    process.exit(0);
  }
  // 126 and 127: the shell could not run it. No change to the work fixes that.
  if (result.status === 126 || result.status === 127) {
    emitVerdict(
      "fail-blocking",
      `"${command}" could not be run here (exit ${result.status}): ${output || "no output"}`,
    );
    process.exit(0);
  }
  if (result.status !== 0) {
    const how = result.status === null ? `signal ${result.signal}` : `exit ${result.status}`;
    emitVerdict(
      "fail-retryable",
      `Paths matching ${when.join(", ")} changed since ${base}, and "${command}" failed (${how}). End of its output:\n${output || "(it printed nothing)"}`,
    );
    process.exit(0);
  }
}

emitVerdict("pass");

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
