import { branchNameOf } from "./branch-name.js";
import { DEFAULT_EXCLUDES } from "./copy-working-files.js";
import { gitFold } from "./fold.js";
import { createGitIsolation, gitIsolation } from "./isolation.js";
import { gitReference } from "./reference.js";
import type { IsolationStrategy } from "./types.js";

/** The strategy as a config with no `isolationOptions` gets it. */
export const strategy: IsolationStrategy = {
  isolation: gitIsolation,
  fold: gitFold,
  reference: gitReference,
  refOf: branchNameOf,
};

const OPTION_KEYS = new Set(["exclude"]);

/**
 * The strategy shaped by a Project's `workLine.isolationOptions`. Strict, like
 * a manager's options: an unknown key or a wrong type stops `mason run`
 * before it isolates anything.
 *
 * `exclude` replaces the default list (`.env`, `.env.*`) rather than adding
 * to it: a Project that names its own list has looked at the default.
 */
export function createStrategy(
  raw: Record<string, unknown>,
): { ok: true; strategy: IsolationStrategy } | { ok: false; reason: string } {
  for (const key of Object.keys(raw)) {
    if (!OPTION_KEYS.has(key)) {
      return {
        ok: false,
        reason: `isolationOptions "${key}" is not one @bluewombat/isolation-git reads (known: ${[...OPTION_KEYS].join(", ")}).`,
      };
    }
  }
  const exclude = raw.exclude === undefined ? DEFAULT_EXCLUDES : raw.exclude;
  if (
    !Array.isArray(exclude) ||
    exclude.some((entry) => typeof entry !== "string" || entry.trim().length === 0)
  ) {
    return {
      ok: false,
      reason: 'isolationOptions "exclude" must be a list of non-empty path patterns.',
    };
  }
  return {
    ok: true,
    strategy: { ...strategy, isolation: createGitIsolation({ exclude: [...exclude] }) },
  };
}
