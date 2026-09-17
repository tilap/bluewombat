import type { GateSpec, GateTraceEntry, Invocation } from "../types.js";
import { parseGateVerdictJson } from "./parse-child-output.js";
import { runChild, type SpawnOutcome } from "./run-child.js";

export type GateRunResult = {
  entry: GateTraceEntry;
  /** When not pass, the Attempt ends with this (or interrupted). */
  stop?: "fail-retryable" | "fail-blocking" | "interrupted";
};

export async function runGate(input: {
  invocation: Invocation;
  attempt: number;
  gate: GateSpec;
  timeoutMs: number;
  shouldInterrupt: () => boolean;
}): Promise<GateRunResult> {
  const { invocation, attempt, gate, timeoutMs, shouldInterrupt } = input;

  const argv = [
    ...gate.argv,
    "--id",
    invocation.id,
    "--attempt",
    String(attempt),
    "--gate-id",
    gate.id,
    "--intention",
    invocation.intention,
    "--definition-of-done",
    invocation.definitionOfDone,
    "--stage",
    invocation.stage ?? "unit",
  ];

  const outcome = await runChild({
    argv,
    cwd: invocation.workspace,
    timeoutMs,
    shouldInterrupt,
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
    const report = `killed after ${timeoutMs}ms, its own ceiling`;
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
        report: "Gate stdout is not a JSON object with a known verdict.",
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
