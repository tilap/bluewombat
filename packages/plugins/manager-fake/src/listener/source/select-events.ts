/**
 * Cursor arithmetic over Source file names. Pure: no directory is touched here,
 * so ordering and cursor filtering are testable from a list of names.
 */

/** Byte-wise comparison, so ordering does not depend on a locale. */
export function compareCursors(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

/** A name the Source protocol publishes an Event under. */
export function isEventName(name: string): boolean {
  return name.endsWith(".json") && !name.startsWith(".");
}

/**
 * Selected Event names, ordered, keeping only those strictly after the Cursor.
 */
export function selectEvents(names: string[], cursor: string | undefined): string[] {
  const selected = names.filter(isEventName).sort(compareCursors);
  if (cursor === undefined) {
    return selected;
  }
  return selected.filter((name) => compareCursors(name, cursor) > 0);
}
