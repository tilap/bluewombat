import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { slugOf } from "./slug.js";

export type ThreadPaths = {
  slug: string;
  /** Machine surface, and the truth of the Thread. */
  records: string;
  /** Human surface, a rendering of the records. */
  page: string;
};

export function threadPathsFor(target: string, key: string): ThreadPaths {
  const slug = slugOf(key);
  return {
    slug,
    records: join(target, `${slug}.ndjson`),
    page: join(target, `${slug}.md`),
  };
}

export type SeenResult = { ok: true; seen: boolean } | { ok: false; detail: string };

/**
 * Whether this event id is already in the Thread. Scanning the records is
 * enough at the scale of a directory a human reads; an index would be state to
 * keep consistent with the truth it indexes.
 */
export function hasEventId(recordsPath: string, eventId: string): SeenResult {
  if (!existsSync(recordsPath)) {
    return { ok: true, seen: false };
  }
  let content: string;
  try {
    content = readFileSync(recordsPath, "utf8");
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
  for (const line of content.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as { event_id?: unknown };
      if (parsed.event_id === eventId) {
        return { ok: true, seen: true };
      }
    } catch {
      // A line this Block did not write is not an event id it has to honour.
    }
  }
  return { ok: true, seen: false };
}

export type AppendResult = { ok: true } | { ok: false; detail: string };

/** One append, so a line lands whole or not at all. */
export function appendOnce(path: string, content: string): AppendResult {
  try {
    appendFileSync(path, content, { encoding: "utf8" });
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/** The `# <key>` title a page carries once, written with the first section. */
export function pagePrefix(page: string, key: string): string {
  return existsSync(page) ? "" : `# ${key}\n\n`;
}
