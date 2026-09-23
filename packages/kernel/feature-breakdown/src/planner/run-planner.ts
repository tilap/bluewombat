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
      answer: {
        kind: "unavailable",
        detail: withChildWords("The Planner clock fired.", spawn.stdout, spawn.stderr),
      },
      finished: { kind: plannerFinishedKind("timed_out") },
    };
  }
  if (spawn.kind === "spawn_error") {
    return {
      answer: {
        kind: "unavailable",
        detail: withChildWords(
          "The Planner could not be started. Check that the command exists and is executable.",
          "",
          spawn.detail,
        ),
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
        detail: withChildWords("The Planner exited without answering.", spawn.stdout, spawn.stderr),
      },
      finished,
    };
  }

  const parsed: PlannerParsed = parsePlannerStdout(spawn.stdout);
  if (parsed.kind === "unusable") {
    return {
      answer: {
        kind: "unavailable",
        detail: withChildWords(
          "The Planner stdout was not a JSON object.",
          spawn.stdout,
          spawn.stderr,
        ),
      },
      finished,
    };
  }
  if (parsed.kind === "refused") {
    return { answer: { kind: "refused", reason: parsed.reason }, finished };
  }
  return { answer: { kind: "plan", subtasks: parsed.subtasks }, finished };
}

/** The sentence, then the end of what the child wrote. The reason is the last thing it said. */
function withChildWords(sentence: string, stdout: string, stderr: string): string {
  const said = stderr.trim() || stdout.trim();
  if (said.length === 0) {
    return sentence;
  }
  const flat = said.replace(/\s+/g, " ").trim();
  const keep = 800;
  const tail = flat.length <= keep ? flat : flat.slice(-keep);
  return `${sentence} ${tail}`;
}
