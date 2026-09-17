import type { Status, StatusPhase } from "../types.js";

export function buildStatusLabel(phase: StatusPhase, id: string | undefined): string {
  if (phase === "invalid") {
    return "invalid";
  }
  if (id === undefined) {
    throw new Error(`Status phase "${phase}" requires id.`);
  }
  return `${phase}:${id}`;
}

export function makeStatus(input: { phase: StatusPhase; id?: string }): Status {
  const { phase, id } = input;
  const label = buildStatusLabel(phase, id);
  const status: Status = { phase, label };
  if (id !== undefined) {
    status.id = id;
  }
  return status;
}
