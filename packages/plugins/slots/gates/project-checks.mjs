#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  emitVerdict,
  GATE_FLAGS,
  ownArgv,
  parseOptions,
  take,
  textOption,
} from "@bluewombat/slot-kit";
import { createOutputTail } from "../lib/output-tail.mjs";

// Runs one command of the Project's own — a typecheck, a test suite, a linter,
// a build — in the workspace, and answers on its exit code.
//
// --cmd COMMAND (required): run through the shell, so "pnpm test" and
// "pnpm --filter web typecheck" are written as the Project writes them. One
// command per Gate: the report then says which check failed, and the first red
// one stops the sequence before a slower one starts. Give each check its own
// entry, and its own timeoutMs.
//
// Nothing here knows a stack. The command is the Project's; the Gate only owns
// what comes back: 0 passes, a red check is the producer's to fix
// (fail-retryable, with the end of its output, where the error is), and what a
// producer cannot fix is a person's (fail-blocking): a command the shell cannot
// start, or a run that outlived its ceiling.
//
// It runs at both stages. At assembly it is the local answer on the assembled
// ticket, so a Project without a CI of its own is still checked by a machine.

const cwd = process.cwd();
const KEEP_BYTES = 12_000;
// Leave the Gate time to answer before Implementer's own clock reads the silence
// as a refusal with nothing to fix.
const MARGIN_MS = 5_000;
const MIN_RUN_MS = 1_000;

const parsed = parseOptions(ownArgv(process.argv, GATE_FLAGS), { "--cmd": {} }, "project-checks");
if (!parsed.ok) {
  emitVerdict("fail-blocking", `${parsed.reason} Use --cmd "<command>".`);
  process.exit(0);
}
const command = textOption(parsed.values, "cmd");
if (command === undefined || command.trim().length === 0) {
  emitVerdict("fail-blocking", 'project-checks needs --cmd "<command>": the check to run.');
  process.exit(0);
}

const ceilingMs = Number(take(process.argv, "--timeout-ms"));
const limitMs =
  Number.isFinite(ceilingMs) && ceilingMs > 0
    ? Math.max(MIN_RUN_MS, ceilingMs - MARGIN_MS)
    : undefined;

const child = spawn("sh", ["-c", command], {
  cwd,
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
  // CI=true keeps watchers (vitest, jest) from waiting on a terminal that is not there.
  env: { ...process.env, CI: "true", NO_COLOR: "1", FORCE_COLOR: "0" },
});

// Cleaned as it arrives (progress redraws dropped), so they cannot push the error out of the tail.
const tail = createOutputTail(KEEP_BYTES);
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
  emitVerdict("fail-blocking", `project-checks cannot start "${command}": ${error.message}`);
  process.exit(0);
});

child.on("close", (code, signal) => {
  clearTimeout(timer);
  const output = tail.text();
  if (timedOut) {
    emitVerdict(
      "fail-blocking",
      [
        `"${command}" did not finish in ${Math.round((limitMs ?? 0) / 1000)}s and was stopped.`,
        "A person decides: the check is hung, or this Gate's timeoutMs is too short for it.",
        output.length > 0 ? `Last output:\n${output}` : "It printed nothing.",
      ].join("\n"),
    );
    return;
  }
  if (code === 0) {
    emitVerdict("pass");
    return;
  }
  // 126 and 127: the shell found the command but could not run it, or did not
  // find it. No change to the work fixes that.
  if (code === 126 || code === 127) {
    emitVerdict(
      "fail-blocking",
      `"${command}" could not be run here (exit ${code}): ${output || "no output"}`,
    );
    return;
  }
  emitVerdict(
    "fail-retryable",
    [
      `"${command}" failed (${signal === null ? `exit ${code}` : `signal ${signal}`}). End of its output:`,
      output.length > 0 ? output : "(it printed nothing)",
    ].join("\n"),
  );
});

function killGroup() {
  // The shell's whole group: a test runner leaves workers that outlive their parent.
  try {
    if (child.pid !== undefined) {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    child.kill("SIGKILL");
  }
}
