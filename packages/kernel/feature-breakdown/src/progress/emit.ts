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
  if (status.key !== undefined) {
    line.key = status.key;
  }
  write(line);
}

export function withKey(
  key: string | undefined,
  line: Record<string, unknown>,
): Record<string, unknown> {
  if (key !== undefined) {
    line.key = key;
  }
  return line;
}
