import type { Status } from "../types.js";

export type ProgressWriter = (line: Record<string, unknown>) => void;

export function createStdoutProgressWriter(): ProgressWriter {
  return (line) => {
    process.stdout.write(`${JSON.stringify(line)}\n`);
  };
}

export function emitStatusEvent(write: ProgressWriter, taskId: string, status: Status): void {
  const line: Record<string, unknown> = {
    event: "status",
    task_id: taskId,
    phase: status.phase,
    label: status.label,
  };
  if (status.attempt !== undefined) {
    line.attempt = status.attempt;
  }
  if (status.max_attempts !== undefined) {
    line.max_attempts = status.max_attempts;
  }
  if (status.gate_id !== undefined) {
    line.gate_id = status.gate_id;
  }
  write(line);
}
