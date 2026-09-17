/**
 * Cursor arithmetic over what the Source listed. Pure: no request is made here,
 * so ordering, cursor filtering, and the pull-request filter are testable from
 * a list of objects.
 */

import type { Cursor, SkipReason } from "../types.js";

export const CURSOR_SEPARATOR = "#";

/** `<updated_at>#<number>`: when the issue last moved, then which issue it is. */
export function formatCursor(cursor: Cursor): string {
  return `${cursor.updatedAt}${CURSOR_SEPARATOR}${cursor.number}`;
}

export function parseCursor(text: string): Cursor | null {
  const separator = text.lastIndexOf(CURSOR_SEPARATOR);
  if (separator <= 0 || separator === text.length - 1) {
    return null;
  }
  const updatedAt = text.slice(0, separator);
  const number = text.slice(separator + 1);
  if (!/^\d+$/.test(number) || Number.isNaN(Date.parse(updatedAt))) {
    return null;
  }
  return { updatedAt, number: Number(number) };
}

/**
 * Order two Cursors: by the timestamp first, then by the issue number. The
 * timestamp compares byte-wise because GitHub renders every one of them the
 * same way; the number compares as a number, since `#9` precedes `#10`.
 */
export function compareCursors(left: Cursor, right: Cursor): number {
  if (left.updatedAt < right.updatedAt) {
    return -1;
  }
  if (left.updatedAt > right.updatedAt) {
    return 1;
  }
  return left.number - right.number;
}

/**
 * A pull request is not an Event of this Source. GitHub lists both under
 * `/issues`, and only the tracker half is what this Block subscribes to.
 */
export function isPullRequest(entry: Record<string, unknown>): boolean {
  return entry.pull_request !== undefined;
}

export type CursorOfResult =
  | { ok: true; cursor: Cursor }
  | { ok: false; reason: SkipReason; detail: string };

/** The two fields an Event must carry to be placed in the order. */
export function cursorOf(entry: Record<string, unknown>): CursorOfResult {
  const number = entry.number;
  const updatedAt = entry.updated_at;
  if (typeof number !== "number" || !Number.isInteger(number)) {
    return { ok: false, reason: "no-cursor", detail: 'The issue carries no integer "number".' };
  }
  if (typeof updatedAt !== "string" || Number.isNaN(Date.parse(updatedAt))) {
    return { ok: false, reason: "no-cursor", detail: `Issue #${number} carries no "updated_at".` };
  }
  return { ok: true, cursor: { updatedAt, number } };
}

export type Selection =
  | { kind: "event"; cursor: string; payload: Record<string, unknown> }
  | { kind: "skip"; reason: SkipReason; detail: string };

/**
 * What one scan consumes, in the order it consumes it. A malformed entry has
 * no Cursor to place it in the order, so it is reported before the Deliveries.
 */
export function selectEvents(entries: unknown[], since: string | undefined): Selection[] {
  const floor = since === undefined ? null : parseCursor(since);
  const skips: Selection[] = [];
  const events: { cursor: Cursor; text: string; payload: Record<string, unknown> }[] = [];

  for (const entry of entries) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      skips.push({
        kind: "skip",
        reason: "not-object",
        detail: `The Source listed ${describe(entry)}, not an issue.`,
      });
      continue;
    }
    const issue = entry as Record<string, unknown>;
    if (isPullRequest(issue)) {
      continue;
    }
    const cursor = cursorOf(issue);
    if (!cursor.ok) {
      skips.push({ kind: "skip", reason: cursor.reason, detail: cursor.detail });
      continue;
    }
    if (floor !== null && compareCursors(cursor.cursor, floor) <= 0) {
      continue;
    }
    events.push({ cursor: cursor.cursor, text: formatCursor(cursor.cursor), payload: issue });
  }

  events.sort((left, right) => compareCursors(left.cursor, right.cursor));
  return [
    ...skips,
    ...events.map(
      (event): Selection => ({ kind: "event", cursor: event.text, payload: event.payload }),
    ),
  ];
}

function describe(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "an array";
  }
  return `a ${typeof value}`;
}
