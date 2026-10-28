#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  emitVerdict,
  GATE_FLAGS,
  ownArgv,
  parseOptions,
  take,
  textOption,
} from "@bluewombat/slot-kit";
import { parseJunit, scenarioOf } from "../lib/junit.mjs";
import { createOutputTail } from "../lib/output-tail.mjs";

// The tests of a Feature, run on the assembled Feature line: does the Feature do what the
// operator agreed it should? Only the scenarios of this Feature run, not the Project's whole suite.
//
// Nothing here knows a stack. The Project supplies one command, run in the workspace through the
// shell, and the Gate owns the rest: running, comparing.
//
// --run COMMAND (required): runs the tests of the Feature and writes a JUnit XML report. `{ids}`
//   stands for the scenario ids of the manifest joined with "|" (a regular expression:
//   `pnpm test --grep "{ids}"`), `{junit}` for the path the report must be written to.
// --manifest PATH: the scenarios of the Feature. Default feature-tests/scenarios.json: a JSON
//   array of ids, or { "scenarios": [ "S1" | { "id": "S1", "title": "…" } ] }.
// --junit PATH: where --run writes its report. Default feature-tests/results/junit.xml. Removed
//   before the run.
// --max-run-ms N: the most the whole Gate may take. Default 600000 (10 minutes), and never more
//   than the Gate's own ceiling.
//
// A scenario is a manifest id; each test carries its id in its name. The comparison is exact: an
// id with no test, a test with no id, or a test the runner skipped is a failure.
//
// Verdicts: pass; fail-retryable for a red run (a wrong test is its author's to fix, a wrong
// application the producer's: what the caller does with the report is its own rule); fail-blocking for what no change to the application fixes: a missing manifest,
// a run that writes no report or outlives its ceiling.

const cwd = process.cwd();
const KEEP_BYTES = 12_000;
const MARGIN_MS = 5_000;
const MIN_PHASE_MS = 1_000;
const REPORT_CHARS = 8_000;

const parsed = parseOptions(
  ownArgv(process.argv, GATE_FLAGS),
  {
    "--run": {},
    "--manifest": { fallback: "feature-tests/scenarios.json" },
    "--junit": { fallback: "feature-tests/results/junit.xml" },
    "--max-run-ms": { fallback: "600000" },
  },
  "feature-tests",
);
if (!parsed.ok) {
  emitVerdict("fail-blocking", parsed.reason);
  process.exit(0);
}
const runTemplate = textOption(parsed.values, "run");
if (runTemplate === undefined || runTemplate.trim().length === 0) {
  emitVerdict(
    "fail-blocking",
    'feature-tests needs --run "<command>". The Project supplies the command that runs the tests.',
  );
  process.exit(0);
}
const maxRunMs = positive(textOption(parsed.values, "maxRunMs"));
if (maxRunMs === undefined) {
  emitVerdict("fail-blocking", "feature-tests: --max-run-ms takes a positive integer.");
  process.exit(0);
}
const manifestPath = inWorkspace(textOption(parsed.values, "manifest") ?? "");
const junitPath = inWorkspace(textOption(parsed.values, "junit") ?? "");

const manifest = readManifest();
if (typeof manifest === "string") {
  emitVerdict("fail-blocking", manifest);
  process.exit(0);
}
// Typed apart from the early exit above: the functions below are hoisted, and a narrowing does not reach them.
/** @type {string[]} */
const ids = manifest;

const ceilingMs = Number(take(process.argv, "--timeout-ms"));
const budgetMs =
  Number.isFinite(ceilingMs) && ceilingMs > 0
    ? Math.min(maxRunMs, Math.max(MIN_PHASE_MS, ceilingMs - MARGIN_MS))
    : maxRunMs;

const [verdict, report] = await judge();
emitVerdict(/** @type {"pass" | "fail-retryable" | "fail-blocking"} */ (verdict), report);
process.exit(0);

/** @returns {Promise<[string, string]>} */
async function judge() {
  rmSync(junitPath, { force: true });
  const command = runTemplate?.replaceAll("{ids}", ids.join("|")).replaceAll("{junit}", junitPath);
  const run = await runShell(/** @type {string} */ (command), budgetMs);
  if (run.timedOut) {
    return ["fail-blocking", timeoutReport(run.output)];
  }
  const results = readResults();
  if (typeof results === "string") {
    return run.code === 0
      ? ["fail-blocking", results]
      : ["fail-retryable", `${results}\n${exitLine(run)} End of its output:\n${run.output}`];
  }
  const failing = failingOf(results);
  if (failing.length > 0) {
    return ["fail-retryable", redReport(results, failing)];
  }
  const foreign = results.cases.filter((c) => scenarioOf(c.name, ids) === undefined);
  if (foreign.length > 0) {
    return [
      "fail-retryable",
      [
        `feature-tests: ${foreign.length} test(s) carry no scenario id of the manifest (${ids.join(", ")}): only the scenarios of the Feature run.`,
        ...foreign.map((c) => `  ${c.name}`),
        "Every test names its scenario id, and --run must run the ids of the manifest only ({ids}).",
      ].join("\n"),
    ];
  }
  return [
    "pass",
    `feature-tests: ${ids.length} scenario(s) of the feature ran and passed: ${ids.join(", ")}.`,
  ];
}

/**
 * @typedef {{ cases: import("../lib/junit.mjs").TestCase[] }} Result
 */

/** @returns {Result | string} */
function readResults() {
  if (!existsSync(junitPath)) {
    return `The run wrote no JUnit report at ${junitPath}. --run must write one there ({junit}).`;
  }
  const cases = parseJunit(readFileSync(junitPath, "utf8"));
  if (cases.length === 0) {
    return `The JUnit report at ${junitPath} holds no test case.`;
  }
  return { cases };
}

/** The scenario ids that are not a pass: failed, skipped, or never run. */
function failingOf(/** @type {Result} */ results) {
  return ids.filter((id) => {
    const mine = results.cases.filter((c) => scenarioOf(c.name, ids) === id);
    return mine.length === 0 || mine.some((c) => c.status !== "passed");
  });
}

function redReport(/** @type {Result} */ results, /** @type {string[]} */ failing) {
  const lines = [
    `feature-tests: ${failing.length} of ${ids.length} scenario(s) failed on the assembled feature: ${failing.join(", ")}.`,
  ];
  for (const id of failing) {
    const mine = results.cases.filter((c) => scenarioOf(c.name, ids) === id);
    if (mine.length === 0) {
      lines.push(`${id} — no test ran for it.`);
      continue;
    }
    for (const c of mine.filter((m) => m.status !== "passed")) {
      lines.push(`${id} — ${c.name}`);
      if (c.status === "skipped") {
        lines.push("  skipped: a skipped scenario is not a passing one.");
        continue;
      }
      lines.push(`  at: ${firstFrame(c.detail) ?? "(no step given)"}`);
      lines.push(`  message: ${c.message.slice(0, 600)}`);
    }
  }
  lines.push(`Report: ${junitPath}.`);
  const text = lines.join("\n");
  return text.length <= REPORT_CHARS ? text : `${text.slice(0, REPORT_CHARS)}\n…`;
}

/** The first stack line that is the test's own, where a step failed. */
function firstFrame(/** @type {string} */ detail) {
  return detail
    .split("\n")
    .map((line) => line.trim())
    .find((line) => /^at\s|\.(spec|test)\.[cm]?[jt]sx?:\d+/.test(line));
}

/**
 * @param {string} command
 * @param {number} limitMs
 * @returns {Promise<{ code: number | null, signal: string | null, timedOut: boolean, output: string }>}
 */
function runShell(command, limitMs) {
  return new Promise((done) => {
    const child = spawn("sh", ["-c", command], {
      cwd,
      env: { ...process.env, CI: "true", NO_COLOR: "1", FORCE_COLOR: "0" },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const tail = createOutputTail(KEEP_BYTES);
    child.stdout.on("data", (chunk) => tail.push("stdout", chunk));
    child.stderr.on("data", (chunk) => tail.push("stderr", chunk));
    let timedOut = false;
    const timer = globalThis.setTimeout(
      () => {
        timedOut = true;
        killGroup(child);
      },
      Math.max(MIN_PHASE_MS, limitMs),
    );
    child.on("error", (error) => {
      clearTimeout(timer);
      done({ code: 127, signal: null, timedOut: false, output: `cannot start: ${error.message}` });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      done({ code, signal, timedOut, output: tail.text() });
    });
  });
}

/** @param {import("node:child_process").ChildProcess} child */
function killGroup(child) {
  try {
    if (child.pid !== undefined) {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    child.kill("SIGKILL");
  }
}

function timeoutReport(/** @type {string} */ output) {
  return [
    `The run did not finish within the ${Math.round(budgetMs / 1000)}s this Gate may take, and was stopped.`,
    "A person decides: the tests hang.",
    output.length > 0 ? `Last output:\n${output}` : "It printed nothing.",
  ].join("\n");
}

function exitLine(/** @type {{ code: number | null, signal: string | null }} */ run) {
  return run.signal === null ? `The run exited ${run.code}.` : `The run got ${run.signal}.`;
}

/** @returns {string[] | string} The ids, or why the manifest is not usable. */
function readManifest() {
  if (!existsSync(manifestPath)) {
    return `The scenarios manifest ${manifestPath} does not exist. The feature-test Ticket writes it: one id per scenario.`;
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return `The scenarios manifest ${manifestPath} is not JSON: ${error instanceof Error ? error.message : error}`;
  }
  const list = Array.isArray(raw) ? raw : raw?.scenarios;
  if (!Array.isArray(list)) {
    return `The scenarios manifest ${manifestPath} must be an array of ids, or { "scenarios": [...] }.`;
  }
  const found = list.map((entry) => (typeof entry === "string" ? entry : entry?.id));
  if (found.some((id) => typeof id !== "string" || id.trim().length === 0)) {
    return `Every scenario of ${manifestPath} needs a non-empty id.`;
  }
  const unique = [...new Set(found.map((id) => id.trim()))];
  if (unique.length !== found.length) {
    return `The scenarios manifest ${manifestPath} lists an id twice.`;
  }
  if (unique.length === 0) {
    return `The scenarios manifest ${manifestPath} lists no scenario: there is nothing to prove.`;
  }
  return unique;
}

function positive(/** @type {string | undefined} */ text) {
  const value = Number(text);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function inWorkspace(/** @type {string} */ path) {
  return isAbsolute(path) ? path : resolve(cwd, path);
}
