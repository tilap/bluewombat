import type { BuilderResult, Invocation, OpenChildSink } from "../types.js";
import { parseBuilderFailureJson } from "./parse-child-output.js";
import { combinedOutput, runChild, type SpawnOutcome } from "./run-child.js";

export type BuilderRunResult = {
  result: BuilderResult;
  /** Report for the next Builder, if this Attempt fails retryably. */
  reportForRetry?: string;
  /** Attempt ended without running Gates. */
  attemptEnded?: "fail-retryable" | "fail-blocking" | "interrupted";
};

export async function runBuilder(input: {
  invocation: Invocation;
  /**
   * The producer for this pass. Chosen by the loop, not read off the
   * invocation: which of the two commands runs depends on whether there is
   * something to resolve, and only the loop knows that.
   */
  producerArgv: string[];
  attempt: number;
  previousReport: string | undefined;
  /** Which Gate refused, when one did. Absent when the producer itself failed. */
  previousRefusedBy: string | undefined;
  timeoutMs: number;
  shouldInterrupt: () => boolean;
  /** Whoever films this child's output. Absent: it is not filmed. */
  onChild?: OpenChildSink | undefined;
}): Promise<BuilderRunResult> {
  const {
    invocation,
    producerArgv,
    attempt,
    previousReport,
    previousRefusedBy,
    timeoutMs,
    shouldInterrupt,
  } = input;

  const argv = [
    ...producerArgv,
    "--id",
    invocation.id,
    "--attempt",
    String(attempt),
    "--intention",
    invocation.intention,
    "--definition-of-done",
    invocation.definitionOfDone,
  ];
  if (previousReport !== undefined) {
    argv.push("--report", previousReport);
  }
  if (previousRefusedBy !== undefined) {
    argv.push("--report-from", previousRefusedBy);
  }
  if (invocation.context !== undefined) {
    argv.push("--context", invocation.context);
  }

  const outcome = await runChild({
    argv,
    cwd: invocation.workspace,
    timeoutMs,
    shouldInterrupt,
    ...(input.onChild === undefined
      ? {}
      : {
          openSink: () =>
            input.onChild?.({
              task_id: invocation.id,
              ...(invocation.context === undefined ? {} : { key: invocation.context }),
              attempt,
              kind: "builder",
            }),
        }),
  });

  return interpretBuilderOutcome(outcome, timeoutMs);
}

function interpretBuilderOutcome(outcome: SpawnOutcome, timeoutMs: number): BuilderRunResult {
  if (outcome.kind === "spawn_error") {
    return {
      result: {
        kind: "refused",
        outcome: "fail-blocking",
        detail: outcome.detail,
      },
      reportForRetry: outcome.detail,
      attemptEnded: "fail-blocking",
    };
  }

  if (outcome.kind === "interrupted") {
    return {
      result: { kind: "interrupted", detail: "stop signal" },
      attemptEnded: "interrupted",
    };
  }

  if (outcome.kind === "timed_out") {
    const detail = withChildWords(
      `killed after ${timeoutMs}ms, its own ceiling`,
      outcome.stdout,
      outcome.stderr,
    );
    return {
      result: {
        kind: "timed_out",
        outcome: "fail-retryable",
        detail,
      },
      reportForRetry: detail,
      attemptEnded: "fail-retryable",
    };
  }

  // exited
  if (outcome.exitCode === 0) {
    return {
      result: { kind: "completed" },
    };
  }

  const failure = parseBuilderFailureJson(outcome.stdout);
  if (failure) {
    return {
      result: {
        kind: "failed",
        outcome: failure.outcome,
        detail: failure.report,
      },
      reportForRetry: failure.report,
      attemptEnded: failure.outcome,
    };
  }

  const detail = combinedOutput(outcome.stdout, outcome.stderr) || `exit ${outcome.exitCode}`;
  return {
    result: {
      kind: "failed",
      outcome: "fail-retryable",
      detail,
    },
    reportForRetry: detail,
    attemptEnded: "fail-retryable",
  };
}

function withChildWords(sentence: string, stdout: string, stderr: string): string {
  const said = combinedOutput(stdout, stderr).trim();
  if (said.length === 0) {
    return sentence;
  }
  return `${sentence} ${said}`;
}
