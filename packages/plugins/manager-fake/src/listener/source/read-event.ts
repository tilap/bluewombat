import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReadEventResult } from "../types.js";

/**
 * Read one Event. Never retried: a file caught mid-write is a publisher that
 * did not rename atomically, and this Block does not guess at write durations.
 */
export function readEvent(source: string, name: string): ReadEventResult {
  let raw: string;
  let bytes: number;
  try {
    const buffer = readFileSync(join(source, name));
    bytes = buffer.byteLength;
    raw = buffer.toString("utf8");
  } catch (error) {
    return {
      ok: false,
      reason: "unreadable",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      reason: "not-json",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "not-object", detail: `Parsed to ${describe(parsed)}.` };
  }

  return { ok: true, payload: parsed as Record<string, unknown>, bytes };
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
