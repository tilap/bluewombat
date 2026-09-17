import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** Film of a run, next to `cursor` under the ledger root. Not truth. */
export const JOURNAL_FILENAME = "events.jsonl";

export type Journal = {
  append(line: Record<string, unknown>): void;
};

export function journalPath(ledgerRoot: string): string {
  return join(ledgerRoot, JOURNAL_FILENAME);
}

/**
 * Append-only JSON lines. Host stamps `at`; Transformer fields pass through.
 *
 * Sync because a Transformer's ProgressWriter is sync, and the film must land
 * before the next phase starts or a crash cuts the process off.
 */
export function openJournalFile(ledgerRoot: string, now: () => Date = () => new Date()): Journal {
  mkdirSync(ledgerRoot, { recursive: true });
  const path = journalPath(ledgerRoot);
  return {
    append(line) {
      const stamped: Record<string, unknown> = { ...line, at: now().toISOString() };
      appendFileSync(path, `${JSON.stringify(stamped)}\n`);
    },
  };
}

/**
 * Split a file chunk into complete JSON objects. A truncated last line stays
 * in `remainder` and is not parsed as a Feature.
 */
export function parseJournalChunk(
  chunk: string,
  remainder: string,
): { lines: Record<string, unknown>[]; remainder: string } {
  const text = `${remainder}${chunk}`;
  const parts = text.split("\n");
  const nextRemainder = parts.pop() ?? "";
  const lines: Record<string, unknown>[] = [];
  for (const part of parts) {
    if (part.trim().length === 0) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(part);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        lines.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Garbage or a split object that gained a newline: skip, do not invent a Feature.
    }
  }
  return { lines, remainder: nextRemainder };
}
