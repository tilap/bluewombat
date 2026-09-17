import type { Invalid } from "../types.js";

export type LabelsResult = { ok: true; names: string[] } | { ok: false; invalid: Invalid };

/**
 * The label names of an issue. GitHub writes them as objects; a caller building
 * a raw intention by hand writes them as strings. Both are read.
 */
export function readLabels(issue: Record<string, unknown>): LabelsResult {
  const value = issue.labels;
  if (value === undefined || value === null) {
    return { ok: true, names: [] };
  }
  if (!Array.isArray(value)) {
    return { ok: false, invalid: badLabels('Field "labels" is not an array.') };
  }

  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      names.push(entry.trim());
      continue;
    }
    if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
      const name = (entry as { name?: unknown }).name;
      if (typeof name === "string") {
        names.push(name.trim());
        continue;
      }
    }
    return { ok: false, invalid: badLabels('An entry of "labels" carries no name.') };
  }
  return { ok: true, names: names.filter((name) => name.length > 0) };
}

function badLabels(reason: string): Invalid {
  return { code: "bad-field-type", reason };
}

/** What the labels carrying this prefix say, with the prefix removed. */
export function valuesWithPrefix(names: string[], prefix: string): string[] {
  return names
    .filter((name) => name.toLowerCase().startsWith(prefix.toLowerCase()))
    .map((name) => name.slice(prefix.length).trim())
    .filter((value) => value.length > 0);
}

export function hasLabel(names: string[], label: string): boolean {
  return names.some((name) => name.toLowerCase() === label.toLowerCase());
}
