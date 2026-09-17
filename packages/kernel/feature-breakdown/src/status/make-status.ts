import type { Status, StatusPhase } from "../types.js";

export function buildStatusLabel(phase: StatusPhase, key: string | undefined): string {
  if (phase === "invalid") {
    return "invalid";
  }
  if (key === undefined) {
    return phase;
  }
  return `${phase}:${key}`;
}

export function makeStatus(input: { phase: StatusPhase; key?: string }): Status {
  const { phase, key } = input;
  const label = buildStatusLabel(phase, key);
  const status: Status = { phase, label };
  if (key !== undefined) {
    status.key = key;
  }
  return status;
}
