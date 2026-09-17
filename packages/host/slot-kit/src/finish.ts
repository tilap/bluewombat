import type { AgentRun } from "./agent.js";
import { readResult } from "./agent.js";
import type { Failure } from "./emit.js";
import { emitFailure } from "./emit.js";

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
 * Answer the Builder contract for a finished run, then leave.
 *
 * Every agent Builder ends here so they classify the same way: exit 0 is a
 * completed pass, and everything else is `fail-blocking` when the CLI itself is
 * unusable, `fail-retryable` when the agent failed at the work.
 */
export function finishRun({ run, bin, name }: FinishedRun): never {
  if (run.error === undefined && run.code === 0 && readResult(run.stdout)?.is_error !== true) {
    process.exit(0);
  }
  const failure = failureOf(run, bin, name);
  emitFailure(failure.outcome, failure.report);
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
