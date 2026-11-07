import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** What the supervisor did about one subject, so that it does not do it forever. */
export type Entry = {
  attempts: number;
  /** The last thing seen, as `observe` fingerprints it. */
  fingerprint: string;
  lastAt: number;
  /** Handed to a person: nothing more is tried until the subject changes or ends. */
  human: boolean;
  /** One line each: what was decided and how it went. Fed back to the next council. */
  history: string[];
};

export type Memory = { entries: Record<string, Entry> };

const FILE = "memory.json";

export function loadMemory(dir: string): Memory {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, FILE), "utf8")) as Memory;
    return { entries: parsed.entries ?? {} };
  } catch {
    return { entries: {} };
  }
}

export function saveMemory(dir: string, memory: Memory): void {
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `${FILE}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(memory, null, 2)}\n`);
  renameSync(tmp, join(dir, FILE));
}

/** Append-only film of what the supervisor saw and did. Not truth: the ledger is. */
export function note(
  dir: string,
  line: Record<string, unknown>,
  now: () => Date = () => new Date(),
): void {
  mkdirSync(dir, { recursive: true });
  appendFileSync(
    join(dir, "events.jsonl"),
    `${JSON.stringify({ ...line, at: now().toISOString() })}\n`,
  );
}

/**
 * Whether this finding is the supervisor's to handle now.
 *
 * Not while a person holds it. Not while what it did last time may still be
 * taking effect (the same thing seen again inside the cooldown). A different
 * fingerprint is a different problem and starts again at the cost already paid.
 */
export function due(
  entry: Entry | undefined,
  fingerprint: string,
  now: number,
  cooldownMs: number,
): boolean {
  if (entry === undefined) {
    return true;
  }
  if (entry.human) {
    return entry.fingerprint !== fingerprint;
  }
  return entry.fingerprint !== fingerprint || now - entry.lastAt >= cooldownMs;
}

export function spent(entry: Entry | undefined, maxAttempts: number): boolean {
  return entry !== undefined && entry.attempts >= maxAttempts;
}

/** Take one attempt at `subject`. */
export function attempt(memory: Memory, subject: string, fingerprint: string, now: number): Entry {
  const entry = memory.entries[subject] ?? {
    attempts: 0,
    fingerprint,
    lastAt: now,
    human: false,
    history: [],
  };
  entry.attempts += 1;
  entry.fingerprint = fingerprint;
  entry.lastAt = now;
  entry.human = false;
  memory.entries[subject] = entry;
  return entry;
}

export function remember(entry: Entry, line: string): void {
  entry.history.push(line);
  if (entry.history.length > 8) {
    entry.history.splice(0, entry.history.length - 8);
  }
}

/** Forget what was kept of a subject that reached an end. */
export function forgetKeys(memory: Memory, keys: string[]): void {
  for (const subject of Object.keys(memory.entries)) {
    if (keys.some((key) => subject.endsWith(`:${key}`))) {
      delete memory.entries[subject];
    }
  }
}
