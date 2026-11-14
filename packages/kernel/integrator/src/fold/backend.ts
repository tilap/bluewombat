import type { FoldStop } from "./working-files.js";

export type FoldBackendResult =
  /**
   * `changed`: whether the fold brought anything into the Parent. Absent: not
   * known, and a caller treats it as changed.
   */
  | { ok: true; changed?: boolean }
  | { ok: false; stop: FoldStop }
  | { ok: false; conflict: true; report: string }
  | { ok: false; detail: string };

/**
 * How Integrator folds the Child into the Parent. The caller injects one;
 * Integrator does not choose a strategy or know git versus copy.
 */
export type FoldBackend = {
  /**
   * The working files of `directory` a failed fold may have to put back, as
   * `/`-separated paths from its root. Integrator asks for the Parent and for
   * the Child and restores the union: the incoming tree is the Child's working
   * tree, so a fold writes only paths one of them lists. Absent, or `undefined`
   * for either directory the backend cannot list: all of the Parent. A path in
   * neither list is never copied. A listed path that is a directory (a
   * submodule) is neither copied nor restored.
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
