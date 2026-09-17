import type { Status } from "../types.js";

export type ProgressWriter = (line: Record<string, unknown>) => void;

export function createStdoutProgressWriter(): ProgressWriter {
  return (line) => {
    process.stdout.write(`${JSON.stringify(line)}\n`);
  };
}

export function emitStatusEvent(write: ProgressWriter, status: Status): void {
  const line: Record<string, unknown> = {
    event: "status",
    phase: status.phase,
    label: status.label,
  };
  if (status.id !== undefined) {
    line.id = status.id;
  }
  write(line);
}
