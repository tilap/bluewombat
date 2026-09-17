import type { FoldBackend } from "@bluewombat/integrator";
import type { IsolationBackend } from "@bluewombat/isolator";
import { loadPlugin, type Shape } from "./load.js";

/** What is at a path today, held against the reference it should be a copy of. */
export type ReferenceCopyState =
  | { kind: "missing" }
  | { kind: "matches" }
  | { kind: "mismatch"; reason: string };

/**
 * One reference work line, read and understood by the strategy. Every method
 * is bound to the value `parse` accepted, so nothing loosely typed travels
 * past that call.
 */
export type ParsedReference = {
  ok: true;
  /** One line for `mason doctor` and the trace. */
  summary: string;
  /** The work line Host offers work to, and the Refresher's `--target`. */
  target: string;
  /** Offline. */
  inspect(path: string): ReferenceCopyState;
  /** Fetches a copy to `path`. Network. */
  materialize(path: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  /**
   * What every process that touches the work line must carry — the identity
   * the system commits under, how it authenticates. Host hands it to the
   * Publisher and the Refresher; it never puts it in its own environment, so
   * a Builder does not inherit a credential.
   */
  env?: Record<string, string> | undefined;
};

/**
 * How a strategy reads what a manager names as the reference work line. The
 * words are agreed between the two packages with nothing checking them at
 * compile time, so `parse` is strict: an unknown key, a missing one, a wrong
 * type — each stops the run before it writes anything.
 */
export type ReferenceBackend = {
  parse(raw: Record<string, unknown>): ParsedReference | { ok: false; reason: string };
};

export type IsolationStrategy = {
  isolation: IsolationBackend;
  fold: FoldBackend;
  /** Absent: this strategy cannot keep a copy of a reference work line. */
  reference?: ReferenceBackend;
  /**
   * The name this strategy gave the Child isolated under `id` — what a
   * Publisher is handed as `--ref`. Absent: the id itself is the name.
   */
  refOf?: (id: string) => string;
};

export type ResolveIsolationResult =
  | { ok: true; strategy: IsolationStrategy; specifier: string }
  | { ok: false; reason: string };

/** What a strategy package exports: the strategy, and maybe a way to shape it. */
type StrategyModule = {
  strategy: IsolationStrategy;
  createStrategy?: (
    options: Record<string, unknown>,
  ) => { ok: true; strategy: IsolationStrategy } | { ok: false; reason: string };
};

/**
 * The module must export `strategy` with `isolation` and `fold` backends;
 * `reference`, when present, must be a backend with `parse`, and `refOf` a
 * function. `createStrategy`, when present, must be a function: it is what
 * `workLine.isolationOptions` is handed to.
 */
const strategyShape: Shape<StrategyModule> = {
  kind: "Isolation strategy",
  check(loaded) {
    const strategy = (loaded as { strategy?: unknown } | null)?.strategy;
    if (
      strategy === null ||
      typeof strategy !== "object" ||
      typeof (strategy as { isolation?: unknown }).isolation !== "object" ||
      typeof (strategy as { fold?: unknown }).fold !== "object"
    ) {
      return { ok: false, reason: "does not export strategy" };
    }
    const reference = (strategy as { reference?: unknown }).reference;
    if (
      reference !== undefined &&
      (reference === null ||
        typeof reference !== "object" ||
        typeof (reference as { parse?: unknown }).parse !== "function")
    ) {
      return { ok: false, reason: "exports a reference without parse" };
    }
    const refOf = (strategy as { refOf?: unknown }).refOf;
    if (refOf !== undefined && typeof refOf !== "function") {
      return { ok: false, reason: "exports a refOf that is not a function" };
    }
    const createStrategy = (loaded as { createStrategy?: unknown }).createStrategy;
    if (createStrategy !== undefined && typeof createStrategy !== "function") {
      return { ok: false, reason: "exports a createStrategy that is not a function" };
    }
    const value: StrategyModule = { strategy: strategy as IsolationStrategy };
    if (createStrategy !== undefined) {
      value.createStrategy = createStrategy as NonNullable<StrategyModule["createStrategy"]>;
    }
    return { ok: true, value };
  },
};

/**
 * Load the isolation strategy package named by `workLine.isolation`, shaped
 * by `workLine.isolationOptions` when the config has any. Options handed to
 * a package that takes none are a mistake to stop on, not to ignore: the
 * operator meant them.
 */
export async function resolveIsolationStrategy(
  name: string,
  fromDir: string,
  options?: Record<string, unknown>,
): Promise<ResolveIsolationResult> {
  const loaded = await loadPlugin(name, fromDir, strategyShape);
  if (!loaded.ok) {
    return loaded;
  }
  const { specifier } = loaded;
  if (options === undefined) {
    return { ok: true, strategy: loaded.value.strategy, specifier };
  }
  if (loaded.value.createStrategy === undefined) {
    return {
      ok: false,
      reason: `${specifier} takes no isolationOptions; remove "workLine.isolationOptions" from the config.`,
    };
  }
  const made = loaded.value.createStrategy(options);
  return made.ok ? { ok: true, strategy: made.strategy, specifier } : made;
}
