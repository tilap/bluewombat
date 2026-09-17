import { runFetch } from "../fetch/run-fetch.js";
import { normalize } from "../normalize/normalize.js";
import type { ProgressWriter } from "../progress/emit.js";
import { parseRaw } from "../raw/parse-raw.js";
import type { FeatureStandard, Invalid, Invocation, RunOutcome } from "../types.js";

export type RunResult = {
  outcome: RunOutcome;
  feature?: FeatureStandard;
  invalid?: Invalid;
  detail?: string;
  exitCode: number;
};

export type RunOptions = {
  invocation: Invocation;
  /** The raw intention; the CLI reads it from --raw or stdin. */
  raw: string;
  write?: ProgressWriter;
  now?: () => number;
  interruptFlag?: { interrupted: boolean };
};

function exitCodeFor(outcome: RunOutcome): number {
  switch (outcome) {
    case "converted":
      return 0;
    case "invalid":
      return 1;
    case "invalid-invocation":
      return 2;
    case "unavailable":
      return 3;
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

/** The raw `id`, as written, for the Fetch argv. */
function rawIdArgument(raw: Record<string, unknown>): string | undefined {
  const value = raw.id;
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function rawKindArgument(raw: Record<string, unknown>): string {
  const value = raw.kind;
  return typeof value === "string" && value.trim().length > 0 ? value : "create";
}

/**
 * Run one FeatureAdapter invocation to a run outcome.
 */
export async function runAdapter(options: RunOptions): Promise<RunResult> {
  const { invocation, raw } = options;
  const write = options.write ?? (() => {});
  const now = options.now ?? (() => Date.now());

  const interruptState = options.interruptFlag ?? { interrupted: false };
  const shouldInterrupt = (): boolean => interruptState.interrupted;

  const finishInvalid = (invalid: Invalid): RunResult => {
    write({
      event: "result",
      manager: invocation.manager,
      outcome: "invalid",
      code: invalid.code,
      reason: invalid.reason,
    });
    return { outcome: "invalid", invalid, exitCode: exitCodeFor("invalid") };
  };

  const finishUnavailable = (detail: string): RunResult => {
    write({ event: "result", manager: invocation.manager, outcome: "unavailable", detail });
    return { outcome: "unavailable", detail, exitCode: exitCodeFor("unavailable") };
  };

  const finishInterrupted = (): RunResult => {
    write({ event: "result", manager: invocation.manager, outcome: "interrupted" });
    return { outcome: "interrupted", exitCode: exitCodeFor("interrupted") };
  };

  if (shouldInterrupt()) {
    return finishInterrupted();
  }

  const parsed = parseRaw(raw, invocation.maxRawBytes);
  if (!parsed.ok) {
    // No id to enrich: the Fetch is skipped entirely.
    return finishInvalid(parsed.invalid);
  }

  let merged = parsed.object;
  if (invocation.fetchArgv !== undefined) {
    const argv = [...invocation.fetchArgv, "--manager", invocation.manager];
    const rawId = rawIdArgument(parsed.object);
    if (rawId !== undefined) {
      argv.push("--id", rawId);
    }
    argv.push("--kind", rawKindArgument(parsed.object));

    const fetched = await runFetch({
      argv,
      timeoutMs: invocation.fetchDurationMs ?? 1,
      shouldInterrupt,
    });
    write({ event: "fetch-finished", manager: invocation.manager, result: fetched.kind });

    if (fetched.kind === "interrupted") {
      return finishInterrupted();
    }
    if (fetched.kind === "unavailable") {
      return finishUnavailable(fetched.detail);
    }
    if (fetched.kind === "merged") {
      // The Fetch is the base; the raw intention is the fresher of the two.
      merged = { ...fetched.object, ...parsed.object };
    }
  }

  if (shouldInterrupt()) {
    return finishInterrupted();
  }

  const normalizeOptions = {
    manager: invocation.manager,
    defaultPriority: invocation.defaultPriority,
    normalizedAt: invocation.at ?? new Date(now()).toISOString(),
    ...(invocation.defaultProject !== undefined
      ? { defaultProject: invocation.defaultProject }
      : {}),
  };
  const result = normalize(merged, normalizeOptions);
  if (!result.ok) {
    return finishInvalid(result.invalid);
  }

  write({
    event: "result",
    manager: invocation.manager,
    key: result.feature.key,
    outcome: "converted",
    feature: result.feature,
  });
  return { outcome: "converted", feature: result.feature, exitCode: exitCodeFor("converted") };
}
