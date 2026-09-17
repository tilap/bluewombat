import type { EventRecord } from "../types.js";

/**
 * The machine surface of a Thread.
 *
 * A comment is one surface for two audiences: a human reads the section, and a
 * machine reads the record. The record travels inside an HTML comment, which
 * GitHub renders as nothing at all, so neither audience pays for the other.
 */
export const MARKER_TAG = "feature-event";

export function renderMarker(record: EventRecord): string {
  return `<!-- ${MARKER_TAG} ${JSON.stringify(record)} -->`;
}

/** Every record a comment body carries. A body a human wrote carries none. */
export function readMarkers(body: string): EventRecord[] {
  const pattern = new RegExp(`<!--\\s*${MARKER_TAG}\\s*([\\s\\S]*?)-->`, "g");
  const records: EventRecord[] = [];
  for (const matched of body.matchAll(pattern)) {
    const payload = matched[1];
    if (payload === undefined) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(payload.trim());
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        records.push(parsed as EventRecord);
      }
    } catch {
      // A marker this Block did not write is not a record it has to honour.
    }
  }
  return records;
}

/** Whether this event id is already in the Thread. */
export function hasEventId(bodies: string[], eventId: string): boolean {
  return bodies.some((body) => readMarkers(body).some((record) => record.event_id === eventId));
}
