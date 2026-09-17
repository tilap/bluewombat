/**
 * A slot is spawned with two argv sections: its own options, written by the
 * Project, then the flags the Transformer appends about the work at hand. The
 * slot never chose the second set and must not trip over it, so it needs to
 * know which tokens are whose.
 */

/** Flags Implementer appends after a Gate's own argv. */
export const GATE_FLAGS: ReadonlySet<string> = new Set([
  "--id",
  "--attempt",
  "--gate-id",
  "--intention",
  "--definition-of-done",
  "--stage",
]);

/** Flags Implementer appends after a Builder's own argv. */
export const BUILDER_FLAGS: ReadonlySet<string> = new Set([
  "--id",
  "--attempt",
  "--intention",
  "--definition-of-done",
  "--report",
  "--report-from",
  "--context",
]);

/** Flags FeatureBreakdown appends after a Planner's own argv. */
export const PLANNER_FLAGS: ReadonlySet<string> = new Set([
  "--key",
  "--intention",
  "--max-units",
  "--title",
]);

export const PUBLISHER_FLAGS: ReadonlySet<string> = new Set(["--id", "--ref", "--target"]);

export const REFRESHER_FLAGS: ReadonlySet<string> = new Set(["--target"]);

/** Flags Host appends after a Describer's own argv. */
export const MESSAGE_FLAGS: ReadonlySet<string> = new Set([
  "--id",
  "--title",
  "--intention",
  "--target",
]);

/**
 * Argv tokens that belong to the slot, not to the Transformer that spawned it.
 *
 * `caller` is that Transformer's flag set — `GATE_FLAGS`, `BUILDER_FLAGS`,
 * `PLANNER_FLAGS`, `PUBLISHER_FLAGS` or
 * `REFRESHER_FLAGS`. Each of them takes a value, so a match consumes two tokens.
 */
export function ownArgv(argv: readonly string[], caller: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined) {
      continue;
    }
    if (caller.has(token)) {
      i += 1;
      continue;
    }
    out.push(token);
  }
  return out;
}

/**
 * The Project's `--` splits this slot's own flags from the agent command it
 * hands the rendered prompt to.
 *
 * Absent, or with nothing after it, there is no agent to run: a role that
 * builds a prompt has nowhere to send it.
 */
export function splitRunner(
  tokens: readonly string[],
): { ok: true; own: string[]; runner: string[] } | { ok: false } {
  const at = tokens.indexOf("--");
  if (at < 0) {
    return { ok: false };
  }
  const runner = tokens.slice(at + 1);
  if (runner.length === 0) {
    return { ok: false };
  }
  return { ok: true, own: tokens.slice(0, at), runner };
}

/** The value after `flag`, or nothing when the flag is absent or last. */
export function take(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index < 0 ? undefined : argv[index + 1];
}

/** What a Gate is looking at, when it makes a difference to the answer. */
export function stageOf(argv: readonly string[]): string {
  const at = argv.indexOf("--stage");
  return at < 0 ? "unit" : (argv[at + 1] ?? "unit");
}
