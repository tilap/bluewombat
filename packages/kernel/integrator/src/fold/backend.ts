import type { FoldStop } from "./working-files.js";

export type FoldBackendResult =
  | { ok: true }
  | { ok: false; stop: FoldStop }
  | { ok: false; conflict: true; report: string }
  | { ok: false; detail: string };

/**
 * How Integrator folds the Child into the Parent. The caller injects one;
 * Integrator does not choose a strategy or know git versus copy.
 */
export type FoldBackend = {
  /**
   * The working files of `directory` a failed fold has to put back, as
   * `/`-separated paths from its root. Absent, or `undefined` for a directory
   * the backend cannot list: all of them. A backend that never writes a path
   * (git never writes one it ignores) leaves it out, and the snapshot never
   * copies it.
   */
  snapshotPaths?(directory: string): Promise<readonly string[] | undefined>;
  fold(input: {
    parent: string;
    child: string;
    id?: string;
    subject?: string;
    mergeSubject?: string;
    deadlineMs: number;
    now: () => number;
    shouldInterrupt: () => boolean;
    shouldStop: () => FoldStop | undefined;
  }): Promise<FoldBackendResult>;
};
