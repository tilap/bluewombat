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
 * A Task's id says which unit of work it is — `s1` — and a reader holding that
 * alone cannot say which feature it served. Implementer is handed the answer in
 * `--context` and until now spent it only on filing a transcript. Adding it
 * here rather than at each of the seven emission sites keeps the two facts from
 * drifting apart.
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
