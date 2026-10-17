#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  emitVerdict,
  GATE_FLAGS,
  listOption,
  ownArgv,
  parseOptions,
  pathMatchesGlob,
  take,
  textOption,
} from "@bluewombat/slot-kit";
import { createOutputTail } from "../lib/output-tail.mjs";

// The tests that were just written must FAIL, and for the right reason.
//
// A test that passes before the behaviour exists tests nothing, and one that fails on a
// missing import or a syntax error says nothing about the behaviour either. This Gate
// finds the test files the pass added or changed, runs the Project's own test command on
// them, and answers:
//
//   - the task says `Tests: none`        -> pass: nothing is written first
//   - no test file added or changed      -> fail-retryable: the pass wrote no test
//   - the tests pass                     -> fail-retryable: they test nothing that is missing
//   - they fail on a wrong reason        -> fail-retryable: fix imports, syntax, stubs
//   - they fail on something else        -> pass: red, as a test written first should be
//   - the command cannot run, or hangs   -> fail-blocking: no change to the tests fixes it
//
// --cmd COMMAND (required): run through the shell. `{files}` is replaced by the test files
//   of the pass, quoted, so "pnpm vitest run {files}" runs only those. Without `{files}`
//   the whole command runs as written.
// --test-glob GLOB (repeatable): which paths are test files. Default: **/*.test.*,
//   **/*.spec.*, **/__tests__/**
// --not-red-when REGEX (repeatable, case-insensitive): output that means the tests are red
//   for the wrong reason. Default: a module that cannot be found or resolved, a syntax
//   error, a TypeScript error. Naming any replaces the defaults.

const cwd = process.cwd();
const KEEP_BYTES = 12_000;
const MARGIN_MS = 5_000;
const MIN_RUN_MS = 1_000;
const DEFAULT_GLOBS = ["**/*.test.*", "**/*.spec.*", "**/__tests__/**"];
const DEFAULT_WRONG_REASONS = [
  "Cannot find module",
  "Failed to resolve (import|entry)",
  "ERR_MODULE_NOT_FOUND",
  "SyntaxError",
  "error TS\\d+",
  "Cannot find name",
];

const parsed = parseOptions(
  ownArgv(process.argv, GATE_FLAGS),
  { "--cmd": {}, "--test-glob": { many: true }, "--not-red-when": { many: true } },
  "tests-red",
);
if (!parsed.ok) {
  emitVerdict("fail-blocking", `${parsed.reason} Use --cmd "<command>".`);
  process.exit(0);
}
const template = textOption(parsed.values, "cmd");
if (template === undefined || template.trim().length === 0) {
  emitVerdict("fail-blocking", 'tests-red needs --cmd "<command>": the Project\'s test command.');
  process.exit(0);
}
const globs = listOption(parsed.values, "testGlob");
const testGlobs = globs.length > 0 ? globs : DEFAULT_GLOBS;
const reasons = listOption(parsed.values, "notRedWhen");
let wrongReasons;
try {
  wrongReasons = (reasons.length > 0 ? reasons : DEFAULT_WRONG_REASONS).map(
    (source) => new RegExp(source, "i"),
  );
} catch (error) {
  emitVerdict(
    "fail-blocking",
    `tests-red: --not-red-when is not a pattern: ${error instanceof Error ? error.message : error}`,
  );
  process.exit(0);
}

// A ticket that says `Tests: none` has nothing to write first.
if (/^\s*Tests:\s*none\b/im.test(take(process.argv, "--intention") ?? "")) {
  emitVerdict("pass");
  process.exit(0);
}

if (git(["rev-parse", "--is-inside-work-tree"]).stdout.trim() !== "true") {
  emitVerdict("fail-blocking", "tests-red needs a git workspace.");
  process.exit(0);
}

const files = testFilesOfThePass();
if (files.length === 0) {
  emitVerdict(
    "fail-retryable",
    `No test file was added or changed (test files match: ${testGlobs.join(", ")}). This pass writes the tests of the task, in the files its "Tests" section names.`,
  );
  process.exit(0);
}

const command = template.replaceAll("{files}", files.map(quote).join(" "));
const ceilingMs = Number(take(process.argv, "--timeout-ms"));
const limitMs =
  Number.isFinite(ceilingMs) && ceilingMs > 0
    ? Math.max(MIN_RUN_MS, ceilingMs - MARGIN_MS)
    : undefined;

const child = spawn("sh", ["-c", command], {
  cwd,
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, CI: "true", NO_COLOR: "1", FORCE_COLOR: "0" },
});
const tail = createOutputTail(KEEP_BYTES * 2);
child.stdout.on("data", (chunk) => tail.push("stdout", chunk));
child.stderr.on("data", (chunk) => tail.push("stderr", chunk));

let timedOut = false;
const timer =
  limitMs === undefined
    ? undefined
    : setTimeout(() => {
        timedOut = true;
        killGroup();
      }, limitMs);

child.on("error", (error) => {
  clearTimeout(timer);
  emitVerdict("fail-blocking", `tests-red cannot start "${command}": ${error.message}`);
  process.exit(0);
});

child.on("close", (code) => {
  clearTimeout(timer);
  const output = tail.text();
  const shown = endOf(output);
  if (timedOut) {
    emitVerdict(
      "fail-blocking",
      `"${command}" did not finish in ${Math.round((limitMs ?? 0) / 1000)}s and was stopped. A person decides: the tests hang, or this Gate's timeoutMs is too short.`,
    );
    return;
  }
  if (code === 126 || code === 127) {
    emitVerdict(
      "fail-blocking",
      `"${command}" could not be run here (exit ${code}): ${shown || "no output"}`,
    );
    return;
  }
  if (code === 0) {
    emitVerdict(
      "fail-retryable",
      [
        `These tests pass before the behaviour exists (${files.join(", ")}), so they test nothing that is missing.`,
        "Make each case assert the behaviour the task asks for and the code does not have yet.",
      ].join("\n"),
    );
    return;
  }
  const wrong = wrongReasons.find((pattern) => pattern.test(output));
  if (wrong !== undefined) {
    const line =
      output
        .split("\n")
        .find((one) => wrong.test(one))
        ?.trim() ?? wrong.source;
    emitVerdict(
      "fail-retryable",
      [
        `The tests fail, but not on the missing behaviour: ${line}`,
        "Make them compile and run: fix the import or the syntax, and give the interface under test a minimal stub (right name and signature, no behaviour), so they fail on what they check. End of the output:",
        shown,
      ].join("\n"),
    );
    return;
  }
  emitVerdict("pass");
});

function killGroup() {
  try {
    if (child.pid !== undefined) {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    child.kill("SIGKILL");
  }
}

/** The test files this pass added or changed, and that are still there. */
function testFilesOfThePass() {
  const status = git(["status", "--porcelain", "-z", "-uall"]);
  if (status.status !== 0) {
    return [];
  }
  const found = [];
  const entries = status.stdout.split("\0").filter(Boolean);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] ?? "";
    const path = entry.slice(3);
    if (entry[0] === "R" || entry[1] === "R") {
      i += 1;
    }
    const deleted = entry[0] === "D" || entry[1] === "D";
    if (
      !deleted &&
      existsSync(join(cwd, path)) &&
      testGlobs.some((glob) => pathMatchesGlob(path, glob))
    ) {
      found.push(path);
    }
  }
  return found;
}

/** @param {string} path */
function quote(path) {
  return `'${path.replaceAll("'", "'\\''")}'`;
}

/** The end of the output, where the error is, cut on a line boundary. */
function endOf(/** @type {string} */ text) {
  const cut = text.length > KEEP_BYTES ? text.slice(text.length - KEEP_BYTES) : text;
  return (text.length > KEEP_BYTES ? cut.slice(cut.indexOf("\n") + 1) : cut).trim();
}

/** @param {string[]} args */
function git(args) {
  return spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}
