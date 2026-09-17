import type { Invalid } from "../types.js";

export type ParseRawResult =
  | { ok: true; object: Record<string, unknown> }
  | { ok: false; invalid: Invalid };

/**
 * Structural checks on the raw intention: size, then JSON, then object.
 * Nothing here looks at a field — that is normalization's job.
 */
export function parseRaw(raw: string, maxRawBytes: number): ParseRawResult {
  const bytes = Buffer.byteLength(raw, "utf8");
  if (bytes > maxRawBytes) {
    return {
      ok: false,
      invalid: {
        code: "raw-too-large",
        reason: `The raw intention is ${bytes} bytes, over the ${maxRawBytes} allowed.`,
      },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      invalid: { code: "raw-not-json", reason: `The raw intention is not JSON: ${detail}` },
    };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      invalid: {
        code: "raw-not-object",
        reason: `The raw intention parsed to ${describe(parsed)}, not an object.`,
      },
    };
  }

  return { ok: true, object: parsed as Record<string, unknown> };
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
