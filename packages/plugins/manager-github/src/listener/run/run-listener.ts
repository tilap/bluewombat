import type { GithubClient } from "../../github/client.js";
import { runHook } from "../delivery/run-hook.js";
import { listIssues } from "../github/list-issues.js";
import type { ProgressWriter } from "../progress/emit.js";
import { parseCursor, selectEvents } from "../source/select-events.js";
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
  pages: number;
  exitCode: number;
};

export type RunOptions = {
  invocation: Invocation;
  /** The authenticated channel to the Source. The CLI builds it from a token. */
  github: GithubClient;
  write?: ProgressWriter;
  /** Injectable clock for tests. */
  now?: () => number;
  /** When set, polled for interrupt; otherwise the run is never interrupted. */
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
    pages: 0,
    detail: reason,
  });
  return {
    outcome: "invalid-invocation",
    delivered: 0,
    skipped: 0,
    scans: 0,
    pages: 0,
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
  const write = options.write ?? (() => {});
  const now = options.now ?? (() => Date.now());
  const interruptState = options.interruptFlag ?? { interrupted: false };

  return await runLoop({
    invocation: options.invocation,
    github: options.github,
    write,
    now,
    shouldInterrupt: () => interruptState.interrupted,
    cwd: options.cwd,
  });
}

type LoopInput = {
  invocation: Invocation;
  github: GithubClient;
  write: ProgressWriter;
  now: () => number;
  shouldInterrupt: () => boolean;
  cwd: string | undefined;
};

async function runLoop(input: LoopInput): Promise<RunResult> {
  const { invocation, write, now, shouldInterrupt } = input;
  const deadlineMs = now() + invocation.durationMs;
  const repo = `${invocation.repo.owner}/${invocation.repo.name}`;

  let cursor = invocation.since;
  let delivered = 0;
  let skipped = 0;
  let scans = 0;
  let pages = 0;

  const finish = (outcome: RunOutcome, stopReason: StopReason, detail?: string): RunResult => {
    const line: Record<string, unknown> = {
      event: "run-finished",
      manager: invocation.manager,
      repo,
      outcome,
      stop_reason: stopReason,
      delivered,
      skipped,
      scans,
      pages,
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
      pages,
      exitCode: exitCodeFor(outcome),
    };
    if (cursor !== undefined) {
      result.cursor = cursor;
    }
    return result;
  };

  // Consumed Events, delivered or skipped: both cost a read of the listing.
  const consumed = (): number => delivered + skipped;

  for (;;) {
    if (shouldInterrupt()) {
      return finish("interrupted", "signal");
    }
    if (now() >= deadlineMs) {
      return finish("completed", "duration");
    }

    // The whole scan resumes from the Cursor it started with; what the scan
    // itself delivers is dropped again by selectEvents, page after page.
    const sinceIso = cursor === undefined ? undefined : parseCursor(cursor)?.updatedAt;
    scans += 1;
    write({
      event: "scan",
      manager: invocation.manager,
      repo,
      ...(cursor !== undefined ? { since: cursor } : {}),
    });

    let page = 1;
    let bounded = false;
    for (;;) {
      const listed = await listIssues({
        invocation,
        github: input.github,
        sinceIso,
        page,
        deadlineMs,
        now,
        shouldInterrupt,
      });
      if (!listed.ok) {
        if (listed.interrupted) {
          return finish("interrupted", "signal");
        }
        return finish("source-lost", "source-lost", listed.detail);
      }

      pages += 1;
      const selections = selectEvents(listed.entries, cursor);
      write({
        event: "page",
        manager: invocation.manager,
        repo,
        page,
        pending: selections.length,
      });

      for (const selection of selections) {
        if (shouldInterrupt()) {
          return finish("interrupted", "signal");
        }
        if (consumed() >= invocation.maxEvents) {
          bounded = true;
          break;
        }
        if (now() >= deadlineMs) {
          return finish("completed", "duration");
        }

        if (selection.kind === "skip") {
          // No Cursor to commit: a malformed entry is reported, not consumed.
          write({
            event: "skipped",
            manager: invocation.manager,
            repo,
            reason: selection.reason,
            detail: selection.detail,
          });
          skipped += 1;
          continue;
        }

        const body = JSON.stringify(selection.payload);
        write({
          event: "intention",
          manager: invocation.manager,
          repo,
          cursor: selection.cursor,
          observed_at: new Date(now()).toISOString(),
          bytes: Buffer.byteLength(body, "utf8"),
          payload: selection.payload,
        });
        // Commit only once the Delivery is on stdout: at-least-once, never at-most-once.
        cursor = selection.cursor;
        delivered += 1;
        if (invocation.onIntentionArgv !== undefined) {
          await runHook(
            [
              ...invocation.onIntentionArgv,
              "--manager",
              invocation.manager,
              "--cursor",
              selection.cursor,
              "--payload",
              body,
            ],
            input.cwd,
          );
        }
      }

      if (bounded || listed.lastPageReached) {
        break;
      }
      page += 1;
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
