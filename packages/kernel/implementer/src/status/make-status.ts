import type { Status, StatusPhase } from "../types.js";

export function buildStatusLabel(
  phase: StatusPhase,
  attempt: number | undefined,
  maxAttempts: number | undefined,
  gateId: string | undefined,
): string {
  if (phase === "invalid") {
    return "invalid";
  }
  if (attempt === undefined || maxAttempts === undefined) {
    throw new Error(`Status phase "${phase}" requires attempt and max_attempts.`);
  }
  if (phase === "building") {
    return `building:attempt-${attempt}:${maxAttempts}`;
  }
  if (phase === "gating") {
    if (gateId === undefined) {
      throw new Error('Status phase "gating" requires gate_id.');
    }
    return `gating:${gateId}:attempt-${attempt}:${maxAttempts}`;
  }
  return `${phase}:attempt-${attempt}:${maxAttempts}`;
}

export function makeStatus(input: {
  phase: StatusPhase;
  attempt?: number;
  maxAttempts?: number;
  gateId?: string;
}): Status {
  const { phase, attempt, maxAttempts, gateId } = input;
  const label = buildStatusLabel(phase, attempt, maxAttempts, gateId);
  const status: Status = { phase, label };
  if (phase !== "invalid") {
    if (attempt === undefined || maxAttempts === undefined) {
      throw new Error(`Status phase "${phase}" requires attempt and max_attempts.`);
    }
    status.attempt = attempt;
    status.max_attempts = maxAttempts;
  }
  if (phase === "gating") {
    if (gateId === undefined) {
      throw new Error('Status phase "gating" requires gate_id.');
    }
    status.gate_id = gateId;
  }
  return status;
}
