import type { FoldBackend } from "./backend.js";
import {
  type FoldStop,
  removeSnapshot,
  restoreWorkingFiles,
  snapshotWorkingFiles,
} from "./working-files.js";

export type FoldResult =
  | { ok: true; changed?: boolean }
  | { ok: false; stop: FoldStop }
  | { ok: false; conflict: true; report: string }
  | { ok: false; detail: string };

/**
 * Fold Child working files into Parent through the injected backend.
 * Parent is restored unless the fold completes.
 */
export async function fold(input: {
  parent: string;
  child: string;
  backend: FoldBackend;
  /** Names this Integration in what it writes. */
  id?: string;
  subject?: string;
  mergeSubject?: string;
  deadlineMs: number;
  now: () => number;
  shouldInterrupt: () => boolean;
}): Promise<FoldResult> {
  const { parent, child, backend, id, subject, mergeSubject, deadlineMs, now, shouldInterrupt } =
    input;
  // The incoming tree is the Child's working tree, so a fold can write a Parent
  // path only if the Parent or the Child lists it.
  const listed = async (): Promise<readonly string[] | undefined> => {
    const own = await backend.snapshotPaths?.(parent);
    const incoming = own === undefined ? undefined : await backend.snapshotPaths?.(child);
    return own === undefined || incoming === undefined
      ? undefined
      : [...new Set([...own, ...incoming])];
  };
  const saved = await listed();
  const backup = await snapshotWorkingFiles(parent, saved);

  const shouldStop = (): FoldStop | undefined => {
    if (shouldInterrupt()) {
      return "interrupt";
    }
    if (now() >= deadlineMs) {
      return "clock";
    }
    return undefined;
  };

  const fail = async (result: FoldResult): Promise<FoldResult> => {
    // What is in scope now includes what the fold created.
    const current = saved === undefined ? undefined : await listed();
    await restoreWorkingFiles(parent, backup, saved, current);
    await removeSnapshot(backup);
    return result;
  };

  try {
    const result = await backend.fold({
      parent,
      child,
      ...(id === undefined ? {} : { id }),
      ...(subject === undefined ? {} : { subject }),
      ...(mergeSubject === undefined ? {} : { mergeSubject }),
      deadlineMs,
      now,
      shouldInterrupt,
      shouldStop,
    });

    if (result.ok) {
      await removeSnapshot(backup);
      return result;
    }
    return fail(result);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return fail({
      ok: false,
      detail: `Integration could not complete: ${detail}`,
    });
  }
}
