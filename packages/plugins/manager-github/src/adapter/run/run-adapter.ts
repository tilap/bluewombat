import type { GithubClient } from "../../github/client.js";
import { fetchIssue } from "../github/fetch-issue.js";
import { normalize } from "../normalize/normalize.js";
import type { ProgressWriter } from "../progress/emit.js";
import { parseRaw } from "../raw/parse-raw.js";
import { unwrapIssue } from "../raw/unwrap.js";
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
  /** The authenticated channel a Fetch uses. Required only with `fetch`. */
  github?: GithubClient;
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

/** The issue number a Fetch would re-read, before any normalization. */
function fetchableNumber(issue: Record<string, unknown>): number | undefined {
  const value = issue.number;
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return undefined;
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
    // No issue to re-read: the Fetch is skipped entirely.
    return finishInvalid(parsed.invalid);
  }

  const unwrapped = unwrapIssue(parsed.object);
  let merged = unwrapped;

  if (invocation.fetch) {
    const number = fetchableNumber(unwrapped.issue);
    if (options.github === undefined) {
      return finishUnavailable("No authenticated channel was given for the Fetch.");
    }
    if (number === undefined) {
      // Nothing to ask for: normalization will refuse this with missing-id.
      write({ event: "fetch-finished", manager: invocation.manager, result: "skipped" });
    } else {
      const fetched = await fetchIssue({
        invocation,
        github: options.github,
        number,
        deadlineMs: now() + (invocation.fetchDurationMs ?? 1),
        now,
        shouldInterrupt,
      });
      write({ event: "fetch-finished", manager: invocation.manager, result: fetched.kind });

      if (fetched.kind === "interrupted") {
        return finishInterrupted();
      }
      if (fetched.kind === "unavailable") {
        return finishUnavailable(fetched.detail);
      }
      // The Fetch is the base; the raw intention is the fresher of the two.
      merged = { ...unwrapped, issue: { ...fetched.issue, ...unwrapped.issue } };
    }
  }

  if (shouldInterrupt()) {
    return finishInterrupted();
  }

  const result = normalize(merged, {
    manager: invocation.manager,
    repo: invocation.repo,
    defaultPriority: invocation.defaultPriority,
    projectLabelPrefix: invocation.projectLabelPrefix,
    priorityLabelPrefix: invocation.priorityLabelPrefix,
    readyLabel: invocation.readyLabel,
    normalizedAt: invocation.at ?? new Date(now()).toISOString(),
    ...(invocation.defaultProject !== undefined
      ? { defaultProject: invocation.defaultProject }
      : {}),
  });
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
