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
 * The same film, with facts every line of one run shares.
 *
 * A journal holds every run that ever wrote to this ledger, one after another,
 * and nothing in it says where one stopped and the next began. A reader
 * looking at a line cannot tell whether it comes from the process that is
 * running now or from one that died last week. The stamp is what a line is
 * grouped by; `append` still owns `at`.
 *
 * Stamped fields lose to the line's own: a Transformer that already said
 * `key` knows better than the run does.
 */
export function stampJournal(base: Journal, stamp: Record<string, unknown>): Journal {
  return {
    append(line) {
      base.append({ ...stamp, ...line });
    },
  };
}

/**
 * A pass that found nothing is worth one line, not one line every time.
 *
 * A loop polling every 30 seconds writes two lines a minute saying nothing
 * happened; on a real ledger that was 77% of the film and 46% of its bytes.
 * They are held and written as a single line carrying how many passes it
 * stands for, at most once per `everyMs` — a reader of `watch` still sees the
 * loop turning, and the count means nothing is lost by holding them.
 *
 * A `listen` that did not complete is never quiet, whatever it delivered:
 * a run that cannot see its tracker says `source-lost` on every pass, and that
 * is the one repeated line somebody has to notice.
 */
export function coalesceQuiet(
  base: Journal,
  everyMs = 60_000,
  now: () => number = Date.now,
): Journal {
  let passes = 0;
  let lastAt = now();
  const flush = (): void => {
    if (passes === 0) {
      return;
    }
    base.append({ event: "idle", passes });
    passes = 0;
    lastAt = now();
  };
  return {
    append(line) {
      if (line.event === "idle") {
        // One per pass that found nothing: this is what `passes` counts.
        passes += 1;
        if (now() - lastAt >= everyMs) {
          flush();
        }
        return;
      }
      if (isQuietListen(line)) {
        // A listen that completed and brought nothing says nothing on its own.
        // In a pass that then did work, the work's own lines say it all; in an
        // empty pass, the `idle` beside it already counts the pass.
        return;
      }
      flush();
      base.append(line);
    },
  };
}

/** Nothing arrived, and nothing is wrong. Both halves matter. */
function isQuietListen(line: Record<string, unknown>): boolean {
  return line.event === "listen" && line.deliveries === 0 && line.outcome === "completed";
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
