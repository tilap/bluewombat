import type { FeatureStandard, RefusalCode } from "../types.js";

export type FeatureCheckOk = { ok: true; feature: FeatureStandard };
export type FeatureCheckRefused = { ok: false; code: RefusalCode; reason: string; key?: string };
export type FeatureCheckResult = FeatureCheckOk | FeatureCheckRefused;

const RECOGNISED_FIELDS = ["key", "intention", "title"] as const;

function refused(code: RefusalCode, reason: string, key?: string): FeatureCheckRefused {
  const result: FeatureCheckRefused = { ok: false, code, reason };
  if (key !== undefined) {
    result.key = key;
  }
  return result;
}

function usableKey(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function badFieldType(field: string, expected: string): FeatureCheckRefused {
  return refused(
    "bad-field-type",
    `The FeatureStandard field "${field}" has the wrong type. It must be ${expected}.`,
  );
}

/**
 * Check a FeatureStandard document. Pure: no process spawn.
 * Size is measured in UTF-8 bytes before parsing.
 */
export function checkFeatureStandard(raw: string, maxFeatureBytes: number): FeatureCheckResult {
  const byteLength = Buffer.byteLength(raw, "utf8");
  if (byteLength > maxFeatureBytes) {
    return refused(
      "feature-too-large",
      `The FeatureStandard is ${byteLength} bytes, which exceeds the ceiling of ${maxFeatureBytes} bytes. Provide a smaller document or raise --max-feature-bytes.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return refused(
      "feature-not-json",
      "The FeatureStandard is not valid JSON. Check the document encoding and braces.",
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return refused(
      "feature-not-object",
      "The FeatureStandard must be a JSON object, not an array, string, number, or null.",
    );
  }

  const record = parsed as Record<string, unknown>;

  for (const field of RECOGNISED_FIELDS) {
    if (!(field in record)) {
      continue;
    }
    if (typeof record[field] !== "string") {
      return badFieldType(field, "a string");
    }
  }

  const key = usableKey(record.key);
  if (key === undefined) {
    return refused(
      "missing-key",
      'The FeatureStandard has no usable key. Provide a non-empty string "key".',
    );
  }

  if (typeof record.intention !== "string" || record.intention.trim().length === 0) {
    return refused(
      "missing-intention",
      "The FeatureStandard has no non-empty intention. Say what to split.",
      key,
    );
  }

  const feature: FeatureStandard = {
    key,
    intention: record.intention.trim(),
  };
  if (typeof record.title === "string") {
    const title = record.title.trim();
    if (title.length > 0) {
      feature.title = title;
    }
  }
  return { ok: true, feature };
}
