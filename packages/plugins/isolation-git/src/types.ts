import type { FoldBackend } from "@bluewombat/integrator";
import type { IsolationBackend } from "@bluewombat/isolator";

/** What is at a path today, held against the reference it should be a copy of. */
export type ReferenceCopyState =
  | { kind: "missing" }
  | { kind: "matches" }
  | { kind: "mismatch"; reason: string };

/**
 * One reference work line, read and understood.
 *
 * Every method is bound to the value `parse` accepted, so nothing loosely typed
 * travels past that one call.
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
   * What every git process of this run must carry: the identity the system
   * commits under, and how it authenticates. Host hands it to the slots it
   * spawns on the work line (Publisher, Refresher); this package applies it
   * to its own git calls.
   */
  env: Record<string, string>;
};

/**
 * How this strategy reads what a manager names as the reference work line.
 *
 * `parse` is strict — an unknown key, a missing one, a wrong type — because the
 * words are agreed between two packages with nothing checking them at compile
 * time. A mistake has to stop `mason run` before it writes anything.
 */
export type ReferenceBackend = {
  parse(raw: Record<string, unknown>): ParsedReference | { ok: false; reason: string };
};

/** One Isolation method: how a Child is attached, and how it folds back. */
export type IsolationStrategy = {
  isolation: IsolationBackend;
  fold: FoldBackend;
  /** Absent: this strategy cannot keep a copy of a reference work line. */
  reference?: ReferenceBackend;
  /** The branch a Child isolated under `id` lives on — a Publisher's `--ref`. */
  refOf: (id: string) => string;
};
