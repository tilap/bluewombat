import type { GateSpec, GateTraceEntry, OpenChildSink } from "../types.js";
import { parseGateVerdictJson } from "./parse-gate-output.js";
import { combinedOutput, runChild, type SpawnOutcome } from "./run-child.js";

export type GateRunResult = {
  entry: GateTraceEntry;
  /** When not pass, the Plan is refused (or interrupted). */
  stop?: "fail-retryable" | "fail-blocking" | "interrupted";
};

/**
 * One Gate, checking `workspace` after a Plan is otherwise accepted.
 *
 * Smaller argv than Implementer's Gate: no Attempt counter (this Transformer
 * has none, SPECS.md choice 3), no `--stage`, no `--definition-of-done` — a
 * Project wiring `planner.gates` writes its own Gate for this contract rather
 * than reusing one of the shipped Implementer-shaped scripts as-is.
 */
export async function runGate(input: {
  workspace: string;
  key: string;
  gate: GateSpec;
  timeoutMs: number;
  shouldInterrupt: () => boolean;
  /** Whoever films this child's output. Absent: it is not filmed. */
  onChild?: OpenChildSink | undefined;
}): Promise<GateRunResult> {
  const { workspace, key, gate, timeoutMs, shouldInterrupt } = input;

  const argv = [...gate.argv, "--key", key, "--gate-id", gate.id];

  const outcome = await runChild({
    argv,
    cwd: workspace,
    timeoutMs,
    timeoutClock: "gate",
    shouldInterrupt,
    ...(input.onChild === undefined
      ? {}
      : { openSink: () => input.onChild?.({ key, kind: "gate", gate_id: gate.id }) }),
  });

  return interpretGateOutcome(gate.id, outcome, timeoutMs);
}

function interpretGateOutcome(
  gateId: string,
  outcome: SpawnOutcome,
  timeoutMs: number,
): GateRunResult {
  if (outcome.kind === "spawn_error") {
    return {
      entry: { id: gateId, verdict: "fail-blocking", report: outcome.detail },
      stop: "fail-blocking",
    };
  }

  if (outcome.kind === "interrupted") {
    return {
      entry: { id: gateId, verdict: "fail-blocking", report: "stop signal" },
      stop: "interrupted",
    };
  }

  if (outcome.kind === "timed_out") {
    const report = withChildWords(
      `killed after ${timeoutMs}ms, its own ceiling`,
      outcome.stdout,
      outcome.stderr,
    );
    return {
      entry: { id: gateId, verdict: "fail-retryable", report },
      stop: "fail-retryable",
    };
  }

  const parsed = parseGateVerdictJson(outcome.stdout);
  if (!parsed) {
    return {
      entry: {
        id: gateId,
        verdict: "fail-blocking",
        report: withChildWords(
          "Gate stdout is not a JSON object with a known verdict.",
          outcome.stdout,
          outcome.stderr,
        ),
      },
      stop: "fail-blocking",
    };
  }

  const entry: GateTraceEntry = {
    id: gateId,
    verdict: parsed.verdict,
    report: parsed.report,
  };

  if (parsed.verdict === "pass") {
    return { entry };
  }

  return {
    entry,
    stop: parsed.verdict,
  };
}

function withChildWords(sentence: string, stdout: string, stderr: string): string {
  const said = combinedOutput(stdout, stderr).trim();
  if (said.length === 0) {
    return sentence;
  }
  return `${sentence} ${said}`;
}
