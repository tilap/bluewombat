import { runBuilder } from "../child/run-builder.js";
import { runGate } from "../child/run-gate.js";
import { decideAfterAttempt } from "../loop/decide-after-attempt.js";
import { keyedWriter, type ProgressWriter } from "../progress/emit.js";
import { announceStatus } from "../status/announce.js";
import { makeStatus } from "../status/make-status.js";
import type {
  AttemptEnded,
  BuilderInput,
  Invocation,
  OpenChildSink,
  RunOutcome,
  Trace,
} from "../types.js";

export type RunResult = {
  outcome: RunOutcome;
  traces: Trace[];
  exitCode: number;
};

export type RunOptions = {
  invocation: Invocation;
  write?: ProgressWriter;
  /** Polled for interrupt; absent, never interrupted. Its owner — the CLI or a Host — flips it. */
  interruptFlag?: { interrupted: boolean };
  /** Working directory for spawned children. Undefined lets them inherit. */
  cwd?: string;
  /**
   * Whoever films what the producers and Gates say, as they say it.
   *
   * Absent — the default — nothing is filmed and a child's output leaves this
   * Transformer the way it always has: one word, or the tail of a crash.
   */
  onChild?: OpenChildSink;
};

function exitCodeFor(outcome: RunOutcome): number {
  switch (outcome) {
    case "validated":
      return 0;
    case "escalated":
      return 1;
    case "invalid-invocation":
      return 2;
    case "interrupted":
      return 130;
  }
}

/**
 * The producer for this pass, and how long it may run.
 *
 * A pass with something to resolve is a different job from a first one, and a
 * Project may hand it to a different agent. The choice is on the report, not on
 * the Attempt number: a Task run again because an outside judge sent its result
 * back carries a report from its very first Attempt.
 */
function producerFor(
  invocation: Invocation,
  hasReport: boolean,
): { argv: string[]; timeoutMs: number } | undefined {
  if (invocation.builderArgv === undefined) {
    return undefined;
  }
  if (hasReport && invocation.repairArgv !== undefined) {
    return {
      argv: invocation.repairArgv,
      timeoutMs: invocation.repairTimeoutMs ?? invocation.builderTimeoutMs,
    };
  }
  return { argv: invocation.builderArgv, timeoutMs: invocation.builderTimeoutMs };
}

/**
 * Run one Implementer invocation to a run outcome.
 */
export async function runImplementer(options: RunOptions): Promise<RunResult> {
  const { invocation } = options;
  const write = keyedWriter(options.write ?? (() => {}), invocation.context);

  const interruptState = options.interruptFlag ?? { interrupted: false };
  const shouldInterrupt = () => interruptState.interrupted;

  return await runLoop({
    invocation,
    write,
    shouldInterrupt,
    cwd: options.cwd,
    onChild: options.onChild,
  });
}

async function runLoop(input: {
  invocation: Invocation;
  write: ProgressWriter;
  shouldInterrupt: () => boolean;
  cwd: string | undefined;
  onChild: OpenChildSink | undefined;
}): Promise<RunResult> {
  const { invocation, write, shouldInterrupt } = input;
  const traces: Trace[] = [];
  let previousReport: string | undefined = invocation.report;
  let previousRefusedBy: string | undefined = invocation.reportFrom;

  for (let attempt = 1; attempt <= invocation.maxAttempts; attempt += 1) {
    if (shouldInterrupt()) {
      return finishInterrupted({
        cwd: input.cwd,
        invocation,
        write,
        attempt,
        traces,
        // interrupted before Builder spawn of this Attempt — if no prior Attempt, still interrupted
      });
    }

    const builderInput: BuilderInput = {
      intention: invocation.intention,
      definition_of_done: invocation.definitionOfDone,
    };
    if (previousReport !== undefined) {
      builderInput.report = previousReport;
    }

    if (invocation.builderArgv !== undefined) {
      await announceStatus({
        cwd: input.cwd,
        invocation,
        status: makeStatus({
          phase: "building",
          attempt,
          maxAttempts: invocation.maxAttempts,
        }),
        write,
        shouldInterrupt,
      });
    }

    write({
      event: "attempt-started",
      task_id: invocation.id,
      attempt,
    });

    // A Task with no producer is its Gate sequence alone: nothing is made, and
    // the Attempt is the judgement.
    const producer = producerFor(invocation, previousReport !== undefined);
    const builderRun =
      producer === undefined
        ? {
            result: { kind: "skipped" as const },
            attemptEnded: undefined,
            reportForRetry: undefined,
          }
        : await runBuilder({
            invocation,
            producerArgv: producer.argv,
            attempt,
            previousReport,
            previousRefusedBy,
            timeoutMs: producer.timeoutMs,
            shouldInterrupt,
            onChild: input.onChild,
          });

    if (invocation.builderArgv !== undefined) {
      write({
        event: "builder-finished",
        task_id: invocation.id,
        attempt,
        result: builderRun.result,
      });
    }

    const gateEntries: Trace["gates"] = [];
    let ended: AttemptEnded;

    if (builderRun.attemptEnded !== undefined) {
      ended = builderRun.attemptEnded;
      if (ended === "fail-retryable" || ended === "fail-blocking") {
        previousReport = builderRun.reportForRetry;
        // The producer failed on its own; no Gate refused it.
        previousRefusedBy = undefined;
      }
    } else {
      // Builder completed — run Gates (may be empty → validated).
      let gateStop: AttemptEnded | undefined;
      for (const gate of invocation.gates) {
        if (shouldInterrupt()) {
          gateStop = "interrupted";
          break;
        }

        await announceStatus({
          cwd: input.cwd,
          invocation,
          status: makeStatus({
            phase: "gating",
            attempt,
            maxAttempts: invocation.maxAttempts,
            gateId: gate.id,
          }),
          write,
          shouldInterrupt,
        });

        const gateRun = await runGate({
          invocation,
          attempt,
          gate,
          timeoutMs: gate.timeoutMs,
          shouldInterrupt,
          onChild: input.onChild,
        });

        gateEntries.push(gateRun.entry);
        write({
          event: "gate-finished",
          task_id: invocation.id,
          attempt,
          gate_id: gate.id,
          verdict: gateRun.entry.verdict,
          report: gateRun.entry.report,
        });

        if (gateRun.stop !== undefined) {
          gateStop = gateRun.stop;
          if (gateRun.stop === "fail-retryable" || gateRun.stop === "fail-blocking") {
            previousReport = gateRun.entry.report;
            previousRefusedBy = gate.id;
          }
          break;
        }
      }

      ended = gateStop ?? "validated";
    }

    if (shouldInterrupt() && ended !== "interrupted") {
      // Stop signal raced after child finished: prefer interrupted for in-flight semantics
      // only when we were killed mid-child — already handled. If interrupt arrived between
      // children, treat as interrupted for the Attempt when not already validated.
      if (ended !== "validated") {
        ended = "interrupted";
      }
    }

    const trace: Trace = {
      task_id: invocation.id,
      attempt,
      builder: {
        input: builderInput,
        result: builderRun.result,
      },
      gates: gateEntries,
      ended,
    };
    traces.push(trace);

    write({
      event: "attempt-finished",
      task_id: invocation.id,
      attempt,
      ended,
      trace,
    });

    const decision = decideAfterAttempt({
      ended,
      attemptsStarted: attempt,
      maxAttempts: invocation.maxAttempts,
    });

    if (decision.action === "finish") {
      return finishRun({
        cwd: input.cwd,
        invocation,
        write,
        attempt,
        outcome: decision.outcome,
        traces,
      });
    }

    // retry: clear nothing; Gates restart from first; Builder gets --report
  }

  // Exhausted without finish (should be unreachable — last Attempt always decides).
  return finishRun({
    cwd: input.cwd,
    invocation,
    write,
    attempt: invocation.maxAttempts,
    outcome: "escalated",
    traces,
  });
}

async function finishRun(input: {
  invocation: Invocation;
  write: ProgressWriter;
  attempt: number;
  outcome: Exclude<RunOutcome, "invalid-invocation">;
  traces: Trace[];
  cwd: string | undefined;
}): Promise<RunResult> {
  const { invocation, write, attempt, outcome, traces } = input;
  await announceStatus({
    invocation,
    status: makeStatus({
      phase: outcome,
      attempt,
      maxAttempts: invocation.maxAttempts,
    }),
    write,
    shouldInterrupt: () => false,
    cwd: input.cwd,
  });
  write({
    event: "run-finished",
    task_id: invocation.id,
    outcome,
    traces,
  });
  return { outcome, traces, exitCode: exitCodeFor(outcome) };
}

async function finishInterrupted(input: {
  invocation: Invocation;
  write: ProgressWriter;
  attempt: number;
  traces: Trace[];
  cwd: string | undefined;
}): Promise<RunResult> {
  return finishRun({
    ...input,
    outcome: "interrupted",
  });
}

export function invalidInvocationResult(
  invocationId: string | undefined,
  write: ProgressWriter,
  reason: string,
): RunResult {
  const status = makeStatus({ phase: "invalid" });
  write({
    event: "status",
    task_id: invocationId ?? "",
    phase: status.phase,
    label: status.label,
    reason,
  });
  write({
    event: "run-finished",
    task_id: invocationId ?? "",
    outcome: "invalid-invocation",
    reason,
    traces: [],
  });
  return {
    outcome: "invalid-invocation",
    traces: [],
    exitCode: exitCodeFor("invalid-invocation"),
  };
}
