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

// The tests written first are not the producer's to change.
//
// The pass that writes the tests ends with a checkpoint: its work is committed, with a
// subject that starts with "Tests: ". From then on the producer leaves its own work
// uncommitted, so whatever differs from HEAD is the producer's. This Gate looks at the test
// files that checkpoint holds and fails when one was modified, deleted or renamed: a test
// edited until it passes proves nothing.
//
// Adding a new test file is allowed. Where HEAD is not a checkpoint of the tests pass (a
// Project that runs none), nothing is frozen and the Gate passes.
//
// --test-glob GLOB (repeatable): which paths are test files. Default: **/*.test.*,
//   **/*.spec.*, **/__tests__/**
// --subject-prefix TEXT: how the checkpoint's subject starts. Default: "Tests: "

const cwd = process.cwd();
const DEFAULT_GLOBS = ["**/*.test.*", "**/*.spec.*", "**/__tests__/**"];

const parsed = parseOptions(
  ownArgv(process.argv, GATE_FLAGS),
  { "--test-glob": { many: true }, "--subject-prefix": {} },
  "tests-frozen",
);
if (!parsed.ok) {
  emitVerdict("fail-blocking", parsed.reason);
  process.exit(0);
}
const globs = listOption(parsed.values, "testGlob");
const testGlobs = globs.length > 0 ? globs : DEFAULT_GLOBS;
const prefix = textOption(parsed.values, "subjectPrefix") ?? "Tests: ";

if (git(["rev-parse", "--is-inside-work-tree"]).stdout.trim() !== "true") {
  emitVerdict("fail-blocking", "tests-frozen needs a git workspace.");
  process.exit(0);
}

const subject = git(["log", "-1", "--format=%s"]);
if (subject.status !== 0 || !subject.stdout.trim().startsWith(prefix)) {
  emitVerdict("pass");
  process.exit(0);
}

// The test files the checkpoint holds: those it added or changed in its own commit.
const held = git(["show", "--name-only", "--diff-filter=AM", "--format=", "HEAD"])
  .stdout.split("\n")
  .map((line) => line.trim())
  .filter((path) => path.length > 0 && testGlobs.some((glob) => pathMatchesGlob(path, glob)));
if (held.length === 0) {
  emitVerdict("pass");
  process.exit(0);
}

// The working files against HEAD, whatever the index says; a new file is not in the diff.
const diff = git(["diff", "--no-renames", "--name-status", "-z", "HEAD", "--", ...held]);
if (diff.status !== 0) {
  emitVerdict("fail-blocking", `tests-frozen cannot read git diff: ${diff.stderr.trim()}`);
  process.exit(0);
}
const touched = [];
const parts = diff.stdout.split("\0").filter(Boolean);
for (let i = 0; i < parts.length; i += 2) {
  const path = parts[i + 1];
  if (path !== undefined) {
    touched.push(path);
  }
}

if (touched.length === 0) {
  emitVerdict("pass");
  process.exit(0);
}
emitVerdict(
  "fail-retryable",
  [
    "These tests were written first, from the task's cases, and are not yours to change:",
    ...touched,
    `Restore them (git checkout HEAD -- ${touched.join(" ")}) and make the code pass them as they are. If a test is wrong, say so in your final message instead of editing it.`,
  ].join("\n"),
);

/** @param {string[]} args */
function git(args) {
  return spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}
