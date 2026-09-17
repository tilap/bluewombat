import { createHash } from "node:crypto";

/** JSON with object keys sorted, so two equal documents hash the same. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`);
  return `{${entries.join(",")}}`;
}

/**
 * Answers "did this intention change?". Covers every field of the
 * FeatureStandard except the two that are not the intention itself.
 */
export function fingerprintOf(document: Record<string, unknown>): string {
  const subject: Record<string, unknown> = { ...document };
  delete subject.fingerprint;
  delete subject.normalized_at;
  return `sha256:${createHash("sha256").update(canonicalJson(subject)).digest("hex")}`;
}
