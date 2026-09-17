import { runChild } from "../child/run-child.js";
import type { FeatureStandard, Invocation } from "../types.js";
import { type PlannerParsed, parsePlannerStdout } from "./parse-planner.js";

export type PlannerRun =
  | { kind: "plan"; subtasks: unknown[] }
  | { kind: "refused"; reason: string }
  | { kind: "unavailable"; detail: string }
  | { kind: "interrupted" };

function plannerArgv(feature: FeatureStandard, invocation: Invocation): string[] {
  const argv = [
    ...invocation.plannerArgv,
    "--key",
    feature.key,
    "--intention",
    feature.intention,
    "--max-units",
    String(invocation.maxUnits),
  ];
  if (feature.title !== undefined) {
    argv.push("--title", feature.title);
  }
  return argv;
}

function plannerFinishedKind(
  spawnKind: "exited" | "timed_out" | "interrupted" | "spawn_error",
): string {
  return spawnKind;
}

export type PlannerFinishedEvent = {
  kind: string;
  exitCode?: number;
};

/**
 * Run the Planner once. Working directory is this process cwd.
 * Inherits the environment; sets no extra variables.
 */
export async function runPlanner(input: {
  feature: FeatureStandard;
  invocation: Invocation;
  shouldInterrupt: () => boolean;
  cwd: string | undefined;
}): Promise<{ answer: PlannerRun; finished: PlannerFinishedEvent }> {
  const { feature, invocation, shouldInterrupt, cwd } = input;
  const spawn = await runChild({
    argv: plannerArgv(feature, invocation),
    cwd,
    timeoutMs: invocation.plannerDurationMs,
    timeoutClock: "planner",
    shouldInterrupt,
    preserveStdout: true,
  });

  if (spawn.kind === "interrupted") {
    return {
      answer: { kind: "interrupted" },
      finished: { kind: plannerFinishedKind("interrupted") },
    };
  }
  if (spawn.kind === "timed_out") {
    return {
      answer: { kind: "unavailable", detail: "The Planner clock fired." },
      finished: { kind: plannerFinishedKind("timed_out") },
    };
  }
  if (spawn.kind === "spawn_error") {
    return {
      answer: {
        kind: "unavailable",
        detail:
          "The Planner could not be started. Check that the command exists and is executable.",
      },
      finished: { kind: plannerFinishedKind("spawn_error") },
    };
  }

  const finished: PlannerFinishedEvent = { kind: "exited" };
  if (spawn.exitCode !== null) {
    finished.exitCode = spawn.exitCode;
  }

  if (spawn.exitCode !== 0) {
    return {
      answer: {
        kind: "unavailable",
        detail: "The Planner exited without answering.",
      },
      finished,
    };
  }

  const parsed: PlannerParsed = parsePlannerStdout(spawn.stdout);
  if (parsed.kind === "unusable") {
    return {
      answer: {
        kind: "unavailable",
        detail: "The Planner stdout was not a JSON object.",
      },
      finished,
    };
  }
  if (parsed.kind === "refused") {
    return { answer: { kind: "refused", reason: parsed.reason }, finished };
  }
  return { answer: { kind: "plan", subtasks: parsed.subtasks }, finished };
}
