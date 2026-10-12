import type { AgentRun } from "./agent.js";
import { readResult } from "./agent.js";
import type { Failure } from "./emit.js";
import { emitFailure, writeContract } from "./emit.js";

/**
 * Failures no further Attempt can fix: the CLI is not usable as invoked.
 * Everything else is the agent's work failing, which is what Attempts are for.
 */
const BLOCKING = [
  /not (logged in|authenticated)|please (log ?in|sign ?in)|\blogin\b|unauthori[sz]ed|forbidden/i,
  /failed to authenticate|authentication failed|oauth|session expired|token expired/i,
  /invalid api key|missing api key|api key not/i,
  /credit balance|usage limit reached/i,
  /unknown (option|argument|flag|command)|unrecogni[sz]ed (option|argument)|^usage:/im,
  /unknown model|unsupported model|no such model/i,
];

export type FinishedRun = { run: AgentRun; bin: string; name: string };

/**
 * How a finished run reads: what to answer, and the report to answer it with.
 *
 * Separate from `finishRun` because the classification is the part worth
 * checking, and `finishRun` ends the process.
 */
export function failureOf(
  run: AgentRun,
  bin: string,
  name: string,
): { outcome: Failure; report: string } {
  if (run.error !== undefined) {
    return {
      outcome: "fail-blocking",
      report: `Could not start ${name} at ${bin}: ${run.error.message}`,
    };
  }
  const detail = failureDetail(run, readResult(run.stdout), name);
  return {
    outcome: BLOCKING.some((pattern) => pattern.test(detail)) ? "fail-blocking" : "fail-retryable",
    report: detail,
  };
}

/**
 * The line an agent ends its final message with when what it was given is not
 * enough to act on: `MASON_BLOCKED: <what is missing>`. The Task stops there and
 * the reason goes to a person, instead of another Attempt that would invent a
 * change to have something to show.
 */
const BLOCKED_LINE = /^MASON_BLOCKED:\s*(.*)$/;

/** The reason on the last `MASON_BLOCKED:` line of `said`, or `undefined` when there is none. */
export function blockedReason(said: string): string | undefined {
  const lines = said.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const found = BLOCKED_LINE.exec((lines[i] ?? "").trim());
    if (found !== null) {
      const reason = (found[1] ?? "").trim();
      return reason.length > 0 ? reason : "it did not say what is missing";
    }
  }
  return undefined;
}

/** What the agent said last, from the CLI's own result object. */
function saidOf(run: AgentRun): string {
  const result = readResult(run.stdout);
  return typeof result?.result === "string" ? result.result.trim() : "";
}

/** Kept in the Task's history: enough to know what the agent claimed, not a transcript. */
const SAID_LIMIT = 2_000;

export type RunJudgement =
  | { done: true; said: string }
  | { done: false; outcome: Failure; report: string };

/**
 * How a finished run reads: done, blocked by its own word, or failed.
 *
 * Separate from `finishRun` for the same reason as `failureOf`: the
 * classification is the part worth checking, and `finishRun` ends the process.
 */
export function judgeRun(run: AgentRun, bin: string, name: string): RunJudgement {
  if (run.error === undefined && run.code === 0 && readResult(run.stdout)?.is_error !== true) {
    const said = saidOf(run);
    const blocked = blockedReason(said);
    if (blocked !== undefined) {
      return {
        done: false,
        outcome: "fail-blocking",
        report: `The agent stopped without changing anything: ${blocked}`,
      };
    }
    return { done: true, said: said.slice(0, SAID_LIMIT) };
  }
  const failure = failureOf(run, bin, name);
  return { done: false, outcome: failure.outcome, report: failure.report };
}

/**
 * Answer the Builder contract for a finished run, then leave.
 *
 * Every agent Builder ends here so they classify the same way: exit 0 is a
 * completed pass (with what the agent said, for the Task's history), a
 * `MASON_BLOCKED:` line is `fail-blocking` with its reason, and everything else
 * is `fail-blocking` when the CLI itself is unusable, `fail-retryable` when the
 * agent failed at the work.
 *
 * Answers go through `writeContract`, so a long report is not lost when this
 * process exits.
 */
export function finishRun({ run, bin, name }: FinishedRun): never {
  const judged = judgeRun(run, bin, name);
  if (judged.done) {
    if (judged.said.length > 0) {
      writeContract(`${JSON.stringify({ said: judged.said })}\n`);
    }
    process.exit(0);
  }
  emitFailure(judged.outcome, judged.report);
  process.exit(1);
}

function failureDetail(
  run: AgentRun,
  result: Record<string, unknown> | undefined,
  name: string,
): string {
  if (result !== undefined) {
    for (const field of ["error", "message", "result"]) {
      const value = result[field];
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim().slice(-2000);
      }
    }
  }
  const output = run.output.trim();
  if (output.length > 0) {
    return output.slice(-2000);
  }
  if (run.signal !== null && run.signal !== undefined) {
    return `${name} was killed by ${run.signal}.`;
  }
  return `${name} exited ${run.code} without output.`;
}
