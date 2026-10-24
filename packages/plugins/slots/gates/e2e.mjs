#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
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

// The acceptance suite of a Feature, run on the assembled Feature line: does the product do
// what the operator agreed it should, seen from the outside?
//
// Nothing here knows a stack. The Project supplies four commands, run in the workspace through
// the shell, and the Gate owns the rest: starting, waiting, running, comparing, always stopping.
//
// --up COMMAND (required): starts the application. It may return once started (a daemon, a
//   compose stack) or keep running (a dev server): either way the Gate does not wait for it, it
//   waits for --ready. An `up` that exits non-zero before the app is ready is a start failure.
// --ready COMMAND (required): exit 0 when the application answers. Polled until --start-timeout-ms.
// --run COMMAND (required): runs the suite and writes a JUnit XML report to --junit.
// --rerun COMMAND: runs the failed scenarios again, `{ids}` standing for their ids joined with
//   "|" (a regular expression: `pnpm e2e --grep "{ids}"`). Absent: --run again, whole.
// --down COMMAND (required): stops the application. Always run, whatever happened, and the
//   process group of --up is killed after it.
// --manifest PATH: the scenarios the suite must hold. Default e2e/scenarios.json: a JSON array of
//   ids, or { "scenarios": [ "E1" | { "id": "E1", "title": "…" } ] }.
// --junit PATH: where --run writes its report. Default e2e/results/junit.xml. Removed before the run.
// --server-log PATH: the application's log, whose tail goes in a red report. Default: what --up
//   printed.
// --max-scenarios N: the most scenarios a suite may hold. Default 5.
// --max-run-ms N: the most the whole Gate may take. Default 600000 (10 minutes), and never more
//   than the Gate's own ceiling.
// --start-timeout-ms N: the most --up and --ready may take together. Default 120000.
// --port N: handed to every command as E2E_PORT, for an application that takes its port from the
//   environment. Absent: the application's own choice.
// --host HOST: handed to every command as E2E_HOST. Default 127.0.0.1; anything but a loopback
//   address is refused.
//
// Every command also gets E2E_DATA_DIR (an empty directory made for this run and removed after:
// the data is disposable) and E2E_RESULTS_DIR (where --junit lives). Secrets are not an option
// of the Gate: the commands read them from the environment the operator started mason in.
//
// A scenario is a manifest id; each test carries its id in its name. The comparison is exact: an
// id with no test, a test with no id, or a test the runner skipped is a failure. A test that
// fails is run once more: passing then is flagged unstable in the report, failing twice is red.
//
// Verdicts: pass; fail-retryable for a red suite (the application is the producer's to repair,
// the suite is frozen); fail-blocking for what no change to the application fixes: a missing
// or oversized manifest, an application that does not start or a run that outlives its ceiling.

const cwd = process.cwd();
const KEEP_BYTES = 12_000;
const DOWN_MS = 20_000;
// The Gate answers before its own ceiling, and leaves --down the time to stop the application.
const MARGIN_MS = 5_000 + DOWN_MS;
const MIN_PHASE_MS = 1_000;
const READY_CALL_MS = 15_000;
const READY_EVERY_MS = 1_000;
const LOG_LINES = 40;
const REPORT_CHARS = 8_000;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

const parsed = parseOptions(
  ownArgv(process.argv, GATE_FLAGS),
  {
    "--up": {},
    "--ready": {},
    "--run": {},
    "--rerun": {},
    "--down": {},
    "--manifest": { fallback: "e2e/scenarios.json" },
    "--junit": { fallback: "e2e/results/junit.xml" },
    "--server-log": {},
    "--max-scenarios": { fallback: "5" },
    "--max-run-ms": { fallback: "600000" },
    "--start-timeout-ms": { fallback: "120000" },
    "--host": { fallback: "127.0.0.1" },
    "--port": {},
  },
  "e2e",
);
if (!parsed.ok) {
  emitVerdict("fail-blocking", parsed.reason);
  process.exit(0);
}
const up = textOption(parsed.values, "up");
const ready = textOption(parsed.values, "ready");
const runCommand = textOption(parsed.values, "run");
const rerunCommand = textOption(parsed.values, "rerun");
const down = textOption(parsed.values, "down");
for (const [flag, value] of [
  ["--up", up],
  ["--ready", ready],
  ["--run", runCommand],
  ["--down", down],
]) {
  if (value === undefined || value.trim().length === 0) {
    emitVerdict(
      "fail-blocking",
      `e2e needs ${flag} "<command>". The Project supplies --up, --ready, --run and --down.`,
    );
    process.exit(0);
  }
}
const host = textOption(parsed.values, "host") ?? "127.0.0.1";
if (!LOOPBACK.has(host)) {
  emitVerdict(
    "fail-blocking",
    `e2e serves the application on a loopback address only: "${host}" is not one.`,
  );
  process.exit(0);
}
const maxScenarios = positive(textOption(parsed.values, "maxScenarios"));
const maxRunMs = positive(textOption(parsed.values, "maxRunMs"));
const startTimeoutMs = positive(textOption(parsed.values, "startTimeoutMs"));
if (maxScenarios === undefined || maxRunMs === undefined || startTimeoutMs === undefined) {
  emitVerdict(
    "fail-blocking",
    "e2e: --max-scenarios, --max-run-ms and --start-timeout-ms take a positive integer.",
  );
  process.exit(0);
}
const portText = textOption(parsed.values, "port");
if (portText !== undefined && positive(portText) === undefined) {
  emitVerdict("fail-blocking", `e2e: --port takes a port number, not "${portText}".`);
  process.exit(0);
}
const manifestPath = inWorkspace(textOption(parsed.values, "manifest") ?? "");
const junitPath = inWorkspace(textOption(parsed.values, "junit") ?? "");
const serverLogPath = textOption(parsed.values, "serverLog");

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
const startedAt = Date.now();
const remainingMs = () => budgetMs - (Date.now() - startedAt);

const dataDir = mkdtempSync(join(tmpdir(), "e2e-data-"));
const env = {
  ...process.env,
  CI: "true",
  NO_COLOR: "1",
  FORCE_COLOR: "0",
  E2E_HOST: host,
  ...(portText === undefined ? {} : { E2E_PORT: portText }),
  E2E_DATA_DIR: dataDir,
  E2E_RESULTS_DIR: dirOf(junitPath),
};

/** @type {ReturnType<typeof startBackground> | undefined} */
let server;
// Host stopping the run must not leave an application behind.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server?.kill();
    spawnSync("sh", ["-c", /** @type {string} */ (down)], { cwd, env, timeout: DOWN_MS });
    rmSync(dataDir, { recursive: true, force: true });
    process.exit(1);
  });
}
let verdict = /** @type {[string, string]} */ (["fail-blocking", "e2e ended without a verdict."]);
try {
  verdict = await judge();
} catch (error) {
  verdict = [
    "fail-blocking",
    `e2e could not run: ${error instanceof Error ? error.message : error}`,
  ];
} finally {
  await stop();
}
emitVerdict(/** @type {"pass" | "fail-retryable" | "fail-blocking"} */ (verdict[0]), verdict[1]);
process.exit(0);

/** @returns {Promise<[string, string]>} */
async function judge() {
  server = startBackground(/** @type {string} */ (up));
  const started = await waitReady(/** @type {string} */ (ready));
  if (started !== undefined) {
    return ["fail-blocking", started];
  }

  rmSync(junitPath, { force: true });
  const first = await runShell(/** @type {string} */ (runCommand), remainingMs());
  if (first.timedOut) {
    return ["fail-blocking", timeoutReport("The suite", first.output)];
  }
  const firstResults = readResults();
  if (typeof firstResults === "string") {
    return first.code === 0
      ? ["fail-blocking", firstResults]
      : [
          "fail-retryable",
          `${firstResults}\n${exitLine(first)} End of its output:\n${first.output}`,
        ];
  }
  let results = firstResults;
  let failing = failingOf(results);
  /** @type {string[]} */
  let unstable = [];
  if (failing.length > 0) {
    const again =
      rerunCommand === undefined ? runCommand : rerunCommand.replaceAll("{ids}", failing.join("|"));
    rmSync(junitPath, { force: true });
    const second = await runShell(/** @type {string} */ (again), remainingMs());
    if (second.timedOut) {
      return ["fail-blocking", timeoutReport("The retry of the failed scenarios", second.output)];
    }
    const secondResults = readResults();
    const retried = typeof secondResults === "string" ? undefined : secondResults;
    const stillFailing = retried === undefined ? failing : failingOf(retried, failing);
    unstable = failing.filter((id) => !stillFailing.includes(id));
    // What the retry did not run keeps its first verdict; what it ran takes the second.
    results = retried === undefined ? results : mergeRetry(results, retried, failing);
    failing = stillFailing;
  }
  if (failing.length > 0) {
    return ["fail-retryable", redReport(results, failing)];
  }
  const problems = comparison(results);
  if (problems.length > 0) {
    return ["fail-retryable", problems.join("\n")];
  }
  return ["pass", passReport(results, unstable)];
}

/**
 * Scenario ids failing, for the ids in `among` only when it is given. The comparison with the
 * manifest counts: an id that did not run, a test without an id, a skipped test.
 *
 * @param {Result} results
 * @param {string[]} [among]
 */
function failingOf(results, among) {
  const bad = new Set(comparisonFailures(results));
  const failing = ids.filter((id) => bad.has(id));
  return among === undefined ? failing : failing.filter((id) => among.includes(id));
}

/**
 * @typedef {{ cases: import("../lib/junit.mjs").TestCase[] }} Result
 */

/** @returns {Result | string} */
function readResults() {
  if (!existsSync(junitPath)) {
    return `The suite wrote no JUnit report at ${junitPath}. --run must write one there.`;
  }
  const cases = parseJunit(readFileSync(junitPath, "utf8"));
  if (cases.length === 0) {
    return `The JUnit report at ${junitPath} holds no test case.`;
  }
  return { cases };
}

/** The scenario ids that are not a pass: failed, skipped, or never run. */
function comparisonFailures(/** @type {Result} */ results) {
  const out = new Set();
  for (const id of ids) {
    const mine = results.cases.filter((c) => scenarioOf(c.name, ids) === id);
    if (mine.length === 0 || mine.some((c) => c.status !== "passed")) {
      out.add(id);
    }
  }
  return [...out];
}

/** What the manifest and the report disagree on, beyond a red test: tests no scenario owns. */
function comparison(/** @type {Result} */ results) {
  const foreign = results.cases.filter((c) => scenarioOf(c.name, ids) === undefined);
  return foreign.length === 0
    ? []
    : [
        `e2e: ${foreign.length} test(s) carry no scenario id of the manifest (${ids.join(", ")}): the suite may hold nothing else.`,
        ...foreign.map((c) => `  ${c.name}`),
        "Every test names its scenario id, and every scenario is in the manifest.",
      ];
}

/**
 * @param {Result} first
 * @param {Result} second
 * @param {string[]} retried
 * @returns {Result}
 */
function mergeRetry(first, second, retried) {
  const kept = first.cases.filter((c) => !retried.includes(scenarioOf(c.name, ids) ?? ""));
  const reran = second.cases.filter((c) => retried.includes(scenarioOf(c.name, ids) ?? ""));
  return { cases: [...kept, ...reran] };
}

function passReport(/** @type {Result} */ results, /** @type {string[]} */ unstable) {
  const lines = [
    `e2e: ${ids.length} scenario(s) ran on the assembled feature and passed: ${ids.join(", ")}.`,
  ];
  if (unstable.length > 0) {
    lines.push(`UNSTABLE: ${unstable.join(", ")} passed only on the retry.`);
  }
  const extra = results.cases.length - ids.length;
  if (extra > 0) {
    lines.push(`(${results.cases.length} test cases carry those ids.)`);
  }
  return lines.join("\n");
}

function redReport(/** @type {Result} */ results, /** @type {string[]} */ failing) {
  const lines = [
    `e2e: ${failing.length} of ${ids.length} scenario(s) failed on the assembled feature, twice: ${failing.join(", ")}.`,
    "The suite is frozen: repair the application, never the tests.",
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
      const trace = c.attachments.find((a) => /trace/i.test(a)) ?? c.attachments[0];
      if (trace !== undefined) {
        lines.push(`  trace: ${trace}`);
      }
    }
  }
  const log = logTail();
  if (log.length > 0) {
    lines.push(`Server log, last ${LOG_LINES} lines:`, log);
  }
  lines.push(`Report: ${junitPath}. Screenshots and traces stay on disk beside it.`);
  const text = lines.join("\n");
  return text.length <= REPORT_CHARS ? text : `${text.slice(0, REPORT_CHARS)}\n…`;
}

/** The first stack line that is the suite's own, where a step failed. */
function firstFrame(/** @type {string} */ detail) {
  return detail
    .split("\n")
    .map((line) => line.trim())
    .find((line) => /^at\s|\.(spec|test)\.[cm]?[jt]sx?:\d+/.test(line));
}

function logTail() {
  const fromFile =
    serverLogPath !== undefined && existsSync(inWorkspace(serverLogPath))
      ? readFileSync(inWorkspace(serverLogPath), "utf8")
      : undefined;
  const text = fromFile ?? server?.output() ?? "";
  return text.split("\n").slice(-LOG_LINES).join("\n").trim();
}

/** @returns {Promise<string | undefined>} Why it did not start, or nothing. */
async function waitReady(/** @type {string} */ command) {
  const limit = Math.min(startTimeoutMs ?? 0, remainingMs());
  const until = Date.now() + limit;
  while (Date.now() < until) {
    if (server?.failed() !== undefined) {
      return `The application did not start: "${up}" ${server.failed()}. Its output:\n${server.output()}`;
    }
    const probe = await runShell(command, Math.min(READY_CALL_MS, until - Date.now()));
    if (!probe.timedOut && probe.code === 0) {
      return undefined;
    }
    await sleep(READY_EVERY_MS);
  }
  return `The application was not ready after ${Math.round(limit / 1000)}s ("${command}" never exited 0). Output of "${up}":\n${server?.output() ?? ""}`;
}

/** @param {string} command */
function startBackground(command) {
  const child = spawn("sh", ["-c", command], {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tail = createOutputTail(KEEP_BYTES);
  child.stdout.on("data", (chunk) => tail.push("stdout", chunk));
  child.stderr.on("data", (chunk) => tail.push("stderr", chunk));
  /** @type {string | undefined} */
  let failure;
  child.on("error", (error) => {
    failure = `cannot start: ${error.message}`;
  });
  child.on("close", (code, signal) => {
    if (code !== 0 && code !== null) {
      failure = `exited with ${code}`;
    } else if (signal !== null && !stopping) {
      failure = `was killed by ${signal}`;
    }
  });
  let stopping = false;
  return {
    output: () => tail.text(),
    failed: () => failure,
    kill() {
      stopping = true;
      killGroup(child);
    },
  };
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
      env,
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

async function stop() {
  // The application is stopped the way the Project says, then whatever `up` left is killed.
  try {
    await runShell(/** @type {string} */ (down), DOWN_MS);
  } finally {
    server?.kill();
    rmSync(dataDir, { recursive: true, force: true });
  }
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

function timeoutReport(/** @type {string} */ what, /** @type {string} */ output) {
  return [
    `${what} did not finish within the ${Math.round(budgetMs / 1000)}s this Gate may take, and was stopped.`,
    "A person decides: the suite hangs, or the application does.",
    output.length > 0 ? `Last output:\n${output}` : "It printed nothing.",
  ].join("\n");
}

function exitLine(/** @type {{ code: number | null, signal: string | null }} */ run) {
  return run.signal === null ? `The suite exited ${run.code}.` : `The suite got ${run.signal}.`;
}

/** @returns {string[] | string} The ids, or why the manifest is not usable. */
function readManifest() {
  if (!existsSync(manifestPath)) {
    return `The scenarios manifest ${manifestPath} does not exist. The e2e Ticket writes it: one id per scenario.`;
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
  if (unique.length > (maxScenarios ?? 0)) {
    return `The scenarios manifest lists ${unique.length} scenarios; at most ${maxScenarios} are allowed (--max-scenarios). A person decides which to keep.`;
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

function dirOf(/** @type {string} */ path) {
  return resolve(path, "..");
}
