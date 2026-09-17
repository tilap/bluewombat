import type { ProgressWriter } from "../progress/emit.js";
import { renderEvent } from "../render/render-event.js";
import { appendOnce, hasEventId, pagePrefix, threadPathsFor } from "../thread/thread.js";
import type { Invocation, RunOutcome } from "../types.js";

export type RunResult = {
  outcome: RunOutcome;
  thread?: string;
  detail?: string;
  exitCode: number;
};

export type RunOptions = {
  invocation: Invocation;
  write?: ProgressWriter;
  interruptFlag?: { interrupted: boolean };
};

function exitCodeFor(outcome: RunOutcome): number {
  switch (outcome) {
    case "reported":
    case "duplicate":
    case "rendered":
      return 0;
    case "unreportable":
      return 1;
    case "invalid-invocation":
      return 2;
    case "interrupted":
      return 130;
  }
}

export function invalidInvocationResult(write: ProgressWriter, reason: string): RunResult {
  write({ event: "result", outcome: "invalid-invocation", detail: reason });
  return {
    outcome: "invalid-invocation",
    detail: reason,
    exitCode: exitCodeFor("invalid-invocation"),
  };
}

/**
 * Run one FeatureEmitter invocation to a run outcome.
 */
export function runEmitter(options: RunOptions): RunResult {
  const { invocation } = options;
  const write = options.write ?? (() => {});

  const interruptState = options.interruptFlag ?? { interrupted: false };

  const paths = threadPathsFor(invocation.target, invocation.key);

  const finish = (outcome: RunOutcome, detail?: string): RunResult => {
    const line: Record<string, unknown> = {
      event: "result",
      outcome,
      key: invocation.key,
      project: invocation.project,
      thread: paths.slug,
    };
    if (detail !== undefined) {
      line.detail = detail;
    }
    write(line);
    const result: RunResult = { outcome, thread: paths.slug, exitCode: exitCodeFor(outcome) };
    if (detail !== undefined) {
      result.detail = detail;
    }
    return result;
  };

  if (interruptState.interrupted) {
    return finish("interrupted");
  }

  const rendered = renderEvent(invocation);
  // The page title is part of what a first Event appends, so a preview that
  // left it out would not be the bytes a real run writes.
  const prefix = pagePrefix(paths.page, invocation.key);

  if (invocation.dryRun) {
    write({
      event: "render",
      key: invocation.key,
      thread: paths.slug,
      line: rendered.line,
      section: `${prefix}${rendered.section}`,
    });
    return finish("rendered");
  }

  if (invocation.eventId !== undefined) {
    const seen = hasEventId(paths.records, invocation.eventId);
    if (!seen.ok) {
      return finish("unreportable", seen.detail);
    }
    if (seen.seen) {
      return finish("duplicate");
    }
  }

  const records = appendOnce(paths.records, rendered.line);
  if (!records.ok) {
    return finish("unreportable", records.detail);
  }

  // The Event is committed: finishing the human surface costs one write, so
  // a stop signal from here on does not abandon it half-reported.
  const page = appendOnce(paths.page, `${prefix}${rendered.section}`);
  if (!page.ok) {
    return finish("unreportable", page.detail);
  }

  return finish("reported");
}
