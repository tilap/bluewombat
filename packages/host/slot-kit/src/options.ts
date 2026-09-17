export type OptionRule = {
  /** Collect every occurrence instead of keeping the last. */
  many?: boolean | undefined;
  /** Takes no value: its presence is the value. */
  flag?: boolean | undefined;
  /** The only values accepted. */
  choices?: readonly string[] | undefined;
  /** Used when the Project gave none. */
  fallback?: string | undefined;
};

/** Keyed by the flag as written, e.g. `"--model"`. */
export type OptionSpec = Record<string, OptionRule>;

/** Keyed by the flag in camel case, e.g. `model` for `--model`. */
export type OptionValues = Record<string, string | string[] | boolean | undefined>;

export type ParsedOptions = { ok: true; values: OptionValues } | { ok: false; reason: string };

/**
 * Read a slot's own options from a spec of flags.
 *
 * `{ many: true }` collects a repeatable flag, `{ choices }` validates, and a
 * flag not in the spec is refused rather than passed on: an option meant for
 * the agent CLI that lands here is a config mistake, and a silent one costs a
 * whole run. Keys are the flag name in camel case, and `name` is how the slot
 * calls itself in that refusal.
 */
export function parseOptions(
  tokens: readonly string[],
  spec: OptionSpec,
  name: string,
): ParsedOptions {
  const values: OptionValues = {};
  for (const [flag, rule] of Object.entries(spec)) {
    if (rule.many === true) {
      values[optionKey(flag)] = [];
    } else if (rule.fallback !== undefined) {
      values[optionKey(flag)] = rule.fallback;
    }
  }
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined) {
      continue;
    }
    const rule = spec[token];
    if (rule === undefined) {
      return { ok: false, reason: `The ${name} does not take "${token}".` };
    }
    if (rule.flag === true) {
      values[optionKey(token)] = true;
      continue;
    }
    const value = tokens[i + 1];
    if (value === undefined) {
      return { ok: false, reason: `The ${name} needs a value after ${token}.` };
    }
    i += 1;
    if (rule.choices !== undefined && !rule.choices.includes(value)) {
      return { ok: false, reason: `${token} is ${orList(rule.choices)}, not "${value}".` };
    }
    if (rule.many === true) {
      const collected = values[optionKey(token)];
      if (Array.isArray(collected)) {
        collected.push(value);
      }
    } else {
      values[optionKey(token)] = value;
    }
  }
  return { ok: true, values };
}

function optionKey(flag: string): string {
  return flag.slice(2).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function orList(choices: readonly string[]): string {
  if (choices.length < 2) {
    return `${choices[0]}`;
  }
  return `${choices.slice(0, -1).join(", ")} or ${choices.at(-1)}`;
}

/** The value of a one-shot flag, or nothing: a `many` or `flag` option is not text. */
export function textOption(values: OptionValues, key: string): string | undefined {
  const value = values[key];
  return typeof value === "string" ? value : undefined;
}

/** Every value of a `many` flag; empty for anything else. */
export function listOption(values: OptionValues, key: string): string[] {
  const value = values[key];
  return Array.isArray(value) ? value : [];
}
