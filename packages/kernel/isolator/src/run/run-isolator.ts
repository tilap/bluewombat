import type { IsolationBackend } from "../isolate/backend.js";
import { createChild } from "../isolate/create-child.js";
import { keyedWriter, type ProgressWriter } from "../progress/emit.js";
import { announceStatus } from "../status/announce.js";
import { makeStatus } from "../status/make-status.js";
import type { Invocation, IsolationOutcome } from "../types.js";

export type RunResult = {
  outcome: IsolationOutcome;
  child?: string;
  report?: string;
  exitCode: number;
};

export type RunOptions = {
  invocation: Invocation;
  /** How Isolator produces the Child. Required; Isolator does not sniff `.git`. */
  backend: IsolationBackend;
  write?: ProgressWriter;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Polled for interrupt; absent, never interrupted. Its owner — the CLI or a Host — flips it. */
  interruptFlag?: { interrupted: boolean };
  /** Working directory for the --on-status child. Undefined lets it inherit. */
  cwd?: string;
};

function exitCodeFor(outcome: IsolationOutcome): number {
  switch (outcome) {
    case "isolated":
      return 0;
    case "failed":
      return 1;
    case "invalid-invocation":
      return 2;
    case "interrupted":
      return 130;
  }
}

function withId(id: string | undefined, line: Record<string, unknown>): Record<string, unknown> {
  if (id !== undefined) {
    line.id = id;
  }
  return line;
}

/**
 * Run one Isolator invocation to an Isolation outcome.
 */
export async function runIsolator(options: RunOptions): Promise<RunResult> {
  const { invocation, backend } = options;
  const write = keyedWriter(options.write ?? (() => {}), invocation.context);
  const now = options.now ?? (() => Date.now());

  const interruptState = options.interruptFlag ?? { interrupted: false };
  const shouldInterrupt = () => interruptState.interrupted;

  return await runIsolation({
    invocation,
    backend,
    write,
    now,
    shouldInterrupt,
    cwd: options.cwd,
  });
}

async function runIsolation(input: {
  invocation: Invocation;
  backend: IsolationBackend;
  write: ProgressWriter;
  now: () => number;
  shouldInterrupt: () => boolean;
  cwd: string | undefined;
}): Promise<RunResult> {
  const { invocation, backend, write, now, shouldInterrupt, cwd } = input;

  await announceStatus({
    onStatusArgv: invocation.onStatusArgv,
    status: makeStatus({ phase: "isolating", id: invocation.id }),
    write,
    shouldInterrupt,
    cwd,
  });

  write(
    withId(invocation.id, {
      event: "isolation-started",
    }),
  );

  const deadlineMs = now() + invocation.durationMs;
  const created = await createChild({
    parent: invocation.parent,
    child: invocation.child,
    backend,
    ...(invocation.id === undefined ? {} : { id: invocation.id }),
    deadlineMs,
    now,
    shouldInterrupt,
  });

  if (created.ok) {
    return finishIsolation({
      invocation,
      write,
      outcome: "isolated",
      child: invocation.child,
    });
  }

  if ("stop" in created && created.stop === "interrupt") {
    return finishIsolation({
      invocation,
      write,
      outcome: "interrupted",
    });
  }

  if ("stop" in created && created.stop === "clock") {
    if (shouldInterrupt()) {
      return finishIsolation({
        invocation,
        write,
        outcome: "interrupted",
      });
    }
    return finishIsolation({
      invocation,
      write,
      outcome: "failed",
      report: "The Isolation clock fired.",
    });
  }

  const detail = "detail" in created ? created.detail : "Isolation could not complete.";
  if (shouldInterrupt()) {
    return finishIsolation({
      invocation,
      write,
      outcome: "interrupted",
    });
  }
  return finishIsolation({
    invocation,
    write,
    outcome: "failed",
    report: detail,
  });
}

async function finishIsolation(input: {
  invocation: Invocation;
  write: ProgressWriter;
  outcome: Exclude<IsolationOutcome, "invalid-invocation">;
  child?: string;
  report?: string;
  cwd?: string | undefined;
}): Promise<RunResult> {
  const { invocation, write, outcome } = input;
  await announceStatus({
    onStatusArgv: invocation.onStatusArgv,
    status: makeStatus({ phase: outcome, id: invocation.id }),
    write,
    shouldInterrupt: () => false,
    cwd: input.cwd,
  });

  const finished: Record<string, unknown> = {
    event: "isolation-finished",
    outcome,
  };
  if (outcome === "isolated" && input.child !== undefined) {
    finished.child = input.child;
  }
  if (outcome === "failed" && input.report !== undefined) {
    finished.report = input.report;
  }
  write(withId(invocation.id, finished));

  const result: RunResult = {
    outcome,
    exitCode: exitCodeFor(outcome),
  };
  if (input.child !== undefined) {
    result.child = input.child;
  }
  if (input.report !== undefined) {
    result.report = input.report;
  }
  return result;
}

export async function invalidInvocationResult(input: {
  id: string | undefined;
  onStatusArgv: string[] | undefined;
  write: ProgressWriter;
  reason: string;
  cwd?: string | undefined;
}): Promise<RunResult> {
  const statusInput: { phase: "invalid"; id?: string } = { phase: "invalid" };
  if (input.id !== undefined) {
    statusInput.id = input.id;
  }
  const status = makeStatus(statusInput);
  await announceStatus({
    onStatusArgv: input.onStatusArgv,
    status,
    write: input.write,
    shouldInterrupt: () => false,
    cwd: input.cwd,
  });
  input.write(
    withId(input.id, {
      event: "isolation-finished",
      outcome: "invalid-invocation",
      report: input.reason,
    }),
  );
  const result: RunResult = {
    outcome: "invalid-invocation",
    report: input.reason,
    exitCode: exitCodeFor("invalid-invocation"),
  };
  return result;
}
