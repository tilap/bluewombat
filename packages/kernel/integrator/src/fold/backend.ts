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
