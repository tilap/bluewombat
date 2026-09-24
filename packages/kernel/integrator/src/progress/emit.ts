import type { Status } from "../types.js";

export type ProgressWriter = (line: Record<string, unknown>) => void;

export function createStdoutProgressWriter(): ProgressWriter {
  return (line) => {
    process.stdout.write(`${JSON.stringify(line)}\n`);
  };
}

/**
 * The same writer, naming the larger piece of work every line belongs to.
 *
 * The id names the space this Transformer made or folded; it does not say which
 * feature that space served, and a reader parsing one out of the other is
 * guessing at a format nobody promised. Host is told the answer and passes it
 * down; adding it once here keeps every line consistent with the next.
 *
 * No context, no field: this Transformer never invents what it was not told.
 */
export function keyedWriter(write: ProgressWriter, key: string | undefined): ProgressWriter {
  if (key === undefined) {
    return write;
  }
  return (line) => {
    write({ key, ...line });
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
