import { runHook } from "../delivery/run-hook.js";
import type { ProgressWriter } from "../progress/emit.js";
import { listSource } from "../source/list-source.js";
import { readEvent } from "../source/read-event.js";
import { selectEvents } from "../source/select-events.js";
import type { Invocation, RunOutcome, StopReason } from "../types.js";

export type RunResult = {
  outcome: RunOutcome;
  /** Absent on invalid-invocation: nothing ran, so nothing stopped. */
  stopReason?: StopReason;
  /** Last committed Cursor; absent when no Event was consumed. */
  cursor?: string;
  delivered: number;
  skipped: number;
  scans: number;
  exitCode: number;
};

export type RunOptions = {
  invocation: Invocation;
  write?: ProgressWriter;
  /** Injectable clock for tests. */
  now?: () => number;
  /** When set, polled for interrupt; otherwise process signals are used. */
  interruptFlag?: { interrupted: boolean };
  /** Working directory for the --on-intention child. Undefined lets it inherit. */
  cwd?: string;
};

function exitCodeFor(outcome: RunOutcome): number {
  switch (outcome) {
    case "completed":
      return 0;
    case "source-lost":
      return 1;
    case "invalid-invocation":
      return 2;
    case "interrupted":
      return 130;
  }
}

export function invalidInvocationResult(write: ProgressWriter, reason: string): RunResult {
  write({
    event: "run-finished",
    outcome: "invalid-invocation",
    delivered: 0,
    skipped: 0,
    scans: 0,
    detail: reason,
  });
  return {
    outcome: "invalid-invocation",
    delivered: 0,
    skipped: 0,
    scans: 0,
    exitCode: exitCodeFor("invalid-invocation"),
  };
}

/** Sleep that gives up early on a stop signal or on the duration clock. */
async function waitPoll(input: {
  ms: number;
  now: () => number;
  deadlineMs: number;
  shouldInterrupt: () => boolean;
}): Promise<void> {
  const until = input.now() + input.ms;
  while (input.now() < until) {
    if (input.shouldInterrupt() || input.now() >= input.deadlineMs) {
      return;
    }
    const slice = Math.min(20, until - input.now());
    await new Promise((resolve) => setTimeout(resolve, Math.max(1, slice)));
  }
}

/**
 * Run one FeatureListener invocation to a run outcome.
 */
export async function runListener(options: RunOptions): Promise<RunResult> {
  const { invocation } = options;
  const write = options.write ?? (() => {});
  const now = options.now ?? (() => Date.now());

  const interruptState = options.interruptFlag ?? { interrupted: false };
  const shouldInterrupt = (): boolean => interruptState.interrupted;

  return await runLoop({ invocation, write, now, shouldInterrupt, cwd: options.cwd });
}

async function runLoop(input: {
  invocation: Invocation;
  write: ProgressWriter;
  now: () => number;
  shouldInterrupt: () => boolean;
  cwd: string | undefined;
}): Promise<RunResult> {
  const { invocation, write, now, shouldInterrupt } = input;
  const deadlineMs = now() + invocation.durationMs;

  let cursor = invocation.since;
  let delivered = 0;
  let skipped = 0;
  let scans = 0;

  const finish = (outcome: RunOutcome, stopReason: StopReason, detail?: string): RunResult => {
    const line: Record<string, unknown> = {
      event: "run-finished",
      manager: invocation.manager,
      outcome,
      stop_reason: stopReason,
      delivered,
      skipped,
      scans,
    };
    if (cursor !== undefined) {
      line.cursor = cursor;
    }
    if (detail !== undefined) {
      line.detail = detail;
    }
    write(line);

    const result: RunResult = {
      outcome,
      stopReason,
      delivered,
      skipped,
      scans,
      exitCode: exitCodeFor(outcome),
    };
    if (cursor !== undefined) {
      result.cursor = cursor;
    }
    return result;
  };

  // Consumed Events, delivered or skipped: both cost a read and both burn a Cursor.
  const consumed = (): number => delivered + skipped;

  for (;;) {
    if (shouldInterrupt()) {
      return finish("interrupted", "signal");
    }
    if (now() >= deadlineMs) {
      return finish("completed", "duration");
    }

    const listed = listSource(invocation.source);
    if (!listed.ok) {
      return finish("source-lost", "source-lost", listed.detail);
    }

    const pending = selectEvents(listed.names, cursor);
    scans += 1;
    write({
      event: "scan",
      manager: invocation.manager,
      pending: pending.length,
    });

    for (const name of pending) {
      if (shouldInterrupt()) {
        return finish("interrupted", "signal");
      }
      if (consumed() >= invocation.maxEvents) {
        return finish("completed", "max-events");
      }
      if (now() >= deadlineMs) {
        return finish("completed", "duration");
      }

      const read = readEvent(invocation.source, name);
      if (read.ok) {
        write({
          event: "intention",
          manager: invocation.manager,
          cursor: name,
          observed_at: new Date(now()).toISOString(),
          bytes: read.bytes,
          payload: read.payload,
        });
        // Commit only once the Delivery is on stdout: at-least-once, never at-most-once.
        cursor = name;
        delivered += 1;
        if (invocation.onIntentionArgv !== undefined) {
          await runHook(
            [
              ...invocation.onIntentionArgv,
              "--manager",
              invocation.manager,
              "--cursor",
              name,
              "--payload",
              JSON.stringify(read.payload),
            ],
            input.cwd,
          );
        }
        continue;
      }

      write({
        event: "skipped",
        manager: invocation.manager,
        cursor: name,
        reason: read.reason,
        detail: read.detail,
      });
      cursor = name;
      skipped += 1;
    }

    if (consumed() >= invocation.maxEvents) {
      return finish("completed", "max-events");
    }
    if (!invocation.follow) {
      return finish("completed", "drained");
    }

    await waitPoll({
      ms: invocation.pollIntervalMs ?? 1,
      now,
      deadlineMs,
      shouldInterrupt,
    });
  }
}
