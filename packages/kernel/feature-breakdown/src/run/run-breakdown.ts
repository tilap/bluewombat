import { checkFeatureStandard } from "../feature/check-feature.js";
import { checkPlan } from "../plan/check-plan.js";
import { fingerprintPlan } from "../plan/fingerprint.js";
import { runPlanner } from "../planner/run-planner.js";
import type { ProgressWriter } from "../progress/emit.js";
import { withKey } from "../progress/emit.js";
import { announceStatus } from "../status/announce.js";
import { makeStatus } from "../status/make-status.js";
import type { Invocation, Plan, RefusalCode, RunOutcome, StatusPhase } from "../types.js";

export type RunResult = {
  outcome: RunOutcome;
  exitCode: number;
  plan?: Plan;
  code?: RefusalCode;
  reason?: string;
  detail?: string;
};

export type RunOptions = {
  invocation: Invocation;
  featureJson: string;
  write?: ProgressWriter;
  /** Injectable clock for tests. */
  now?: () => number;
  /** When set, polled for interrupt; otherwise process signals are used. */
  interruptFlag?: { interrupted: boolean };
  /** Working directory for spawned children. Undefined lets them inherit. */
  cwd?: string;
};

function exitCodeFor(outcome: RunOutcome): number {
  switch (outcome) {
    case "planned":
      return 0;
    case "refused":
      return 1;
    case "invalid-invocation":
      return 2;
    case "unavailable":
      return 3;
    case "interrupted":
      return 130;
  }
}

/**
 * Run one FeatureBreakdown invocation to a run outcome.
 */
export async function runBreakdown(options: RunOptions): Promise<RunResult> {
  const { invocation, featureJson } = options;
  const write = options.write ?? (() => {});
  const now = options.now ?? (() => Date.now());

  const interruptState = options.interruptFlag ?? { interrupted: false };
  const shouldInterrupt = () => interruptState.interrupted;

  return await runOnce({ invocation, featureJson, write, now, shouldInterrupt, cwd: options.cwd });
}

async function runOnce(input: {
  invocation: Invocation;
  featureJson: string;
  write: ProgressWriter;
  now: () => number;
  shouldInterrupt: () => boolean;
  cwd: string | undefined;
}): Promise<RunResult> {
  const { invocation, featureJson, write, now, shouldInterrupt } = input;

  const checked = checkFeatureStandard(featureJson, invocation.maxFeatureBytes);
  if (!checked.ok) {
    return finishRefused({
      cwd: input.cwd,
      invocation,
      write,
      key: checked.key,
      code: checked.code,
      reason: checked.reason,
    });
  }

  const feature = checked.feature;
  const key = feature.key;

  if (shouldInterrupt()) {
    return finishOutcome({ cwd: input.cwd, invocation, write, key, outcome: "interrupted" });
  }

  await announceStatus({
    onStatusArgv: invocation.onStatusArgv,
    status: makeStatus({ phase: "planning", key }),
    write,
    shouldInterrupt,
    cwd: input.cwd,
  });

  const planner = await runPlanner({ cwd: input.cwd, feature, invocation, shouldInterrupt });

  write(
    withKey(key, {
      event: "planner-finished",
      kind: planner.finished.kind,
      ...(planner.finished.exitCode !== undefined ? { exitCode: planner.finished.exitCode } : {}),
    }),
  );

  if (shouldInterrupt() || planner.answer.kind === "interrupted") {
    return finishOutcome({ cwd: input.cwd, invocation, write, key, outcome: "interrupted" });
  }

  if (planner.answer.kind === "unavailable") {
    return finishUnavailable({
      cwd: input.cwd,
      invocation,
      write,
      key,
      detail: planner.answer.detail,
    });
  }

  if (planner.answer.kind === "refused") {
    return finishRefused({
      cwd: input.cwd,
      invocation,
      write,
      key,
      code: "not-specifiable",
      reason: planner.answer.reason,
    });
  }

  const planCheck = checkPlan(planner.answer.subtasks, invocation.maxUnits);
  if (!planCheck.ok) {
    return finishRefused({
      cwd: input.cwd,
      invocation,
      write,
      key,
      code: planCheck.code,
      reason: planCheck.reason,
    });
  }

  if (shouldInterrupt()) {
    return finishOutcome({ cwd: input.cwd, invocation, write, key, outcome: "interrupted" });
  }

  const plannedAt = invocation.plannedAt ?? new Date(now()).toISOString();
  const plan: Plan = {
    key,
    subtasks: planCheck.subtasks,
    fingerprint: fingerprintPlan(key, planCheck.subtasks),
    planned_at: plannedAt,
  };

  return finishPlanned({ cwd: input.cwd, invocation, write, key, plan });
}

async function announceOutcome(input: {
  invocation: Invocation;
  write: ProgressWriter;
  key: string | undefined;
  phase: Exclude<StatusPhase, "planning" | "invalid">;
  cwd: string | undefined;
}): Promise<void> {
  const statusInput: { phase: typeof input.phase; key?: string } = { phase: input.phase };
  if (input.key !== undefined) {
    statusInput.key = input.key;
  }
  await announceStatus({
    onStatusArgv: input.invocation.onStatusArgv,
    status: makeStatus(statusInput),
    write: input.write,
    shouldInterrupt: () => false,
    cwd: input.cwd,
  });
}

async function finishPlanned(input: {
  invocation: Invocation;
  write: ProgressWriter;
  key: string;
  plan: Plan;
  cwd: string | undefined;
}): Promise<RunResult> {
  await announceOutcome({
    cwd: input.cwd,
    invocation: input.invocation,
    write: input.write,
    key: input.key,
    phase: "planned",
  });
  input.write(
    withKey(input.key, {
      event: "result",
      outcome: "planned",
      plan: input.plan,
    }),
  );
  return { outcome: "planned", exitCode: exitCodeFor("planned"), plan: input.plan };
}

async function finishRefused(input: {
  invocation: Invocation;
  write: ProgressWriter;
  key: string | undefined;
  code: RefusalCode;
  reason: string;
  cwd: string | undefined;
}): Promise<RunResult> {
  await announceOutcome({
    cwd: input.cwd,
    invocation: input.invocation,
    write: input.write,
    key: input.key,
    phase: "refused",
  });
  input.write(
    withKey(input.key, {
      event: "result",
      outcome: "refused",
      code: input.code,
      reason: input.reason,
    }),
  );
  const result: RunResult = {
    outcome: "refused",
    exitCode: exitCodeFor("refused"),
    code: input.code,
    reason: input.reason,
  };
  return result;
}

async function finishUnavailable(input: {
  invocation: Invocation;
  write: ProgressWriter;
  key: string;
  detail: string;
  cwd: string | undefined;
}): Promise<RunResult> {
  await announceOutcome({
    invocation: input.invocation,
    write: input.write,
    key: input.key,
    phase: "unavailable",
    cwd: input.cwd,
  });
  input.write(
    withKey(input.key, {
      event: "result",
      outcome: "unavailable",
      detail: input.detail,
    }),
  );
  return {
    outcome: "unavailable",
    exitCode: exitCodeFor("unavailable"),
    detail: input.detail,
  };
}

async function finishOutcome(input: {
  invocation: Invocation;
  write: ProgressWriter;
  key: string;
  outcome: "interrupted";
  cwd: string | undefined;
}): Promise<RunResult> {
  await announceOutcome({
    invocation: input.invocation,
    write: input.write,
    key: input.key,
    phase: input.outcome,
    cwd: input.cwd,
  });
  input.write(
    withKey(input.key, {
      event: "result",
      outcome: input.outcome,
    }),
  );
  return { outcome: input.outcome, exitCode: exitCodeFor(input.outcome) };
}

export async function invalidInvocationResult(input: {
  write: ProgressWriter;
  reason: string;
  cwd: string | undefined;
}): Promise<RunResult> {
  await announceStatus({
    onStatusArgv: undefined,
    status: makeStatus({ phase: "invalid" }),
    write: input.write,
    shouldInterrupt: () => false,
    cwd: input.cwd,
  });
  input.write({
    event: "result",
    outcome: "invalid-invocation",
    reason: input.reason,
  });
  return {
    outcome: "invalid-invocation",
    exitCode: exitCodeFor("invalid-invocation"),
    reason: input.reason,
  };
}
