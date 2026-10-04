import type { FoldBackend } from "../fold/backend.js";
import { fold } from "../fold/fold.js";
import { keyedWriter, type ProgressWriter } from "../progress/emit.js";
import { announceStatus } from "../status/announce.js";
import { makeStatus } from "../status/make-status.js";
import type { IntegrationOutcome, Invocation } from "../types.js";

export type RunResult = {
  outcome: IntegrationOutcome;
  parent?: string;
  report?: string;
  exitCode: number;
};

export type RunOptions = {
  invocation: Invocation;
  /** How Integrator folds. Required; Integrator does not sniff `.git`. */
  backend: FoldBackend;
  write?: ProgressWriter;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Polled for interrupt; absent, never interrupted. Its owner — the CLI or a Host — flips it. */
  interruptFlag?: { interrupted: boolean };
  /** Working directory for spawned children. Undefined lets them inherit. */
  cwd?: string;
};

function exitCodeFor(outcome: IntegrationOutcome): number {
  switch (outcome) {
    case "integrated":
      return 0;
    case "conflict":
      return 1;
    case "invalid-invocation":
      return 2;
    case "failed":
      return 3;
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
 * Run one Integrator invocation to an Integration outcome.
 */
export async function runIntegrator(options: RunOptions): Promise<RunResult> {
  const { invocation, backend } = options;
  const write = keyedWriter(options.write ?? (() => {}), invocation.context);
  const now = options.now ?? (() => Date.now());

  const interruptState = options.interruptFlag ?? { interrupted: false };
  const shouldInterrupt = () => interruptState.interrupted;

  return await runIntegration({
    invocation,
    backend,
    write,
    now,
    shouldInterrupt,
    cwd: options.cwd,
  });
}

async function runIntegration(input: {
  invocation: Invocation;
  backend: FoldBackend;
  write: ProgressWriter;
  now: () => number;
  shouldInterrupt: () => boolean;
  cwd: string | undefined;
}): Promise<RunResult> {
  const { invocation, backend, write, now, shouldInterrupt } = input;

  await announceStatus({
    onStatusArgv: invocation.onStatusArgv,
    status: makeStatus({ phase: "integrating", id: invocation.id }),
    write,
    shouldInterrupt,
    cwd: input.cwd,
  });

  write(
    withId(invocation.id, {
      event: "integration-started",
    }),
  );

  const deadlineMs = now() + invocation.durationMs;
  const folded = await fold({
    parent: invocation.parent,
    child: invocation.child,
    backend,
    ...(invocation.id === undefined ? {} : { id: invocation.id }),
    ...(invocation.subject === undefined ? {} : { subject: invocation.subject }),
    ...(invocation.mergeSubject === undefined ? {} : { mergeSubject: invocation.mergeSubject }),
    deadlineMs,
    now,
    shouldInterrupt,
  });

  if (folded.ok) {
    // A stop signal racing a just-completed fold uses integrated.
    return finishIntegration({
      cwd: input.cwd,
      invocation,
      write,
      outcome: "integrated",
      parent: invocation.parent,
    });
  }

  if ("stop" in folded && folded.stop === "interrupt") {
    return finishIntegration({ cwd: input.cwd, invocation, write, outcome: "interrupted" });
  }

  if ("stop" in folded && folded.stop === "clock") {
    if (shouldInterrupt()) {
      return finishIntegration({ cwd: input.cwd, invocation, write, outcome: "interrupted" });
    }
    return finishIntegration({
      cwd: input.cwd,
      invocation,
      write,
      outcome: "failed",
      report: "The Integration clock fired.",
    });
  }

  if ("conflict" in folded && folded.conflict) {
    if (shouldInterrupt()) {
      return finishIntegration({ cwd: input.cwd, invocation, write, outcome: "interrupted" });
    }
    return finishIntegration({
      cwd: input.cwd,
      invocation,
      write,
      outcome: "conflict",
      report: folded.report,
    });
  }

  const detail = "detail" in folded ? folded.detail : "Integration could not complete.";
  if (shouldInterrupt()) {
    return finishIntegration({ cwd: input.cwd, invocation, write, outcome: "interrupted" });
  }
  return finishIntegration({
    cwd: input.cwd,
    invocation,
    write,
    outcome: "failed",
    report: detail,
  });
}

async function finishIntegration(input: {
  invocation: Invocation;
  write: ProgressWriter;
  outcome: Exclude<IntegrationOutcome, "invalid-invocation">;
  parent?: string;
  report?: string;
  cwd: string | undefined;
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
    event: "integration-finished",
    outcome,
  };
  if (outcome === "integrated" && input.parent !== undefined) {
    finished.parent = input.parent;
  }
  if ((outcome === "conflict" || outcome === "failed") && input.report !== undefined) {
    finished.report = input.report;
  }
  write(withId(invocation.id, finished));

  const result: RunResult = {
    outcome,
    exitCode: exitCodeFor(outcome),
  };
  if (input.parent !== undefined) {
    result.parent = input.parent;
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
  cwd: string | undefined;
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
      event: "integration-finished",
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
