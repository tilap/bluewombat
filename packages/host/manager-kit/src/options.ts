/**
 * Readers for one `managerOptions` object.
 *
 * Values reach a manager either from JSON (already typed) or from repeated
 * `--manager-option key=value` flags (always strings), so a reader that wants a
 * number or a boolean accepts the string spelling of one.
 */

export type OptionResult<T> = { ok: true; value: T | undefined } | { ok: false; reason: string };

export type Options = Record<string, unknown>;

export function stringOption(options: Options, key: string): OptionResult<string> {
  const value = options[key];
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return { ok: false, reason: `managerOptions "${key}" must be a non-empty string.` };
  }
  return { ok: true, value };
}

/** A JSON array of strings, or one string from a single `--manager-option`. */
export function stringArrayOption(options: Options, key: string): OptionResult<string[]> {
  const value = options[key];
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (typeof value === "string") {
    return value.trim().length === 0
      ? { ok: false, reason: `managerOptions "${key}" must not be empty.` }
      : { ok: true, value: [value] };
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    return { ok: false, reason: `managerOptions "${key}" must be an array of strings.` };
  }
  return { ok: true, value: value as string[] };
}

export function intOption(
  options: Options,
  key: string,
  min: number,
  max: number,
): OptionResult<number> {
  const value = options[key];
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  const parsed = typeof value === "string" && /^-?\d+$/.test(value.trim()) ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    return {
      ok: false,
      reason: `managerOptions "${key}" must be an integer between ${min} and ${max}.`,
    };
  }
  return { ok: true, value: parsed };
}

export function booleanOption(options: Options, key: string): OptionResult<boolean> {
  const value = options[key];
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (typeof value === "boolean") {
    return { ok: true, value };
  }
  if (value === "true" || value === "false") {
    return { ok: true, value: value === "true" };
  }
  return { ok: false, reason: `managerOptions "${key}" must be true or false.` };
}

/**
 * A misspelled option is silently ignored otherwise, and the manager then runs
 * with a default the user thought they had changed.
 */
export function rejectUnknownOptions(
  options: Options,
  known: readonly string[],
): { ok: true } | { ok: false; reason: string } {
  const allowed = new Set(known);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) {
      return {
        ok: false,
        reason: `managerOptions has unknown key "${key}". Known: ${[...allowed].sort().join(", ")}.`,
      };
    }
  }
  return { ok: true };
}
