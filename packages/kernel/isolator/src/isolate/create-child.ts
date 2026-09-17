import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { IsolationBackend } from "./backend.js";
import { type IsolationStop, IsolationStoppedError, throwIfStopped } from "./stop.js";

export type CreateChildResult =
  | { ok: true }
  | { ok: false; stop: IsolationStop }
  | { ok: false; detail: string };

function remainingMs(deadlineMs: number, now: number): number {
  return Math.max(1, deadlineMs - now);
}

/**
 * Create `--child` as a snapshot of the Parent's working files, through the
 * injected backend. Isolator does not choose a strategy.
 */
export async function createChild(input: {
  parent: string;
  child: string;
  backend: IsolationBackend;
  /** Passed to the strategy; may name a branch or other label. */
  id?: string;
  deadlineMs: number;
  now: () => number;
  shouldInterrupt: () => boolean;
}): Promise<CreateChildResult> {
  const { parent, child, backend, id, deadlineMs, now, shouldInterrupt } = input;
  let created = false;

  const shouldStop = (): IsolationStop | undefined => {
    if (shouldInterrupt()) {
      return "interrupt";
    }
    if (now() >= deadlineMs) {
      return "clock";
    }
    return undefined;
  };

  const fail = async (result: CreateChildResult): Promise<CreateChildResult> => {
    if (created || existsSync(child)) {
      await backend.abort({ parent, child });
      await rm(child, { recursive: true, force: true });
    }
    return result;
  };

  try {
    await throwIfStopped(shouldStop);
    await mkdir(dirname(child), { recursive: true });

    const attached = await backend.attach({
      parent,
      child,
      ...(id === undefined ? {} : { id }),
      timeoutMs: remainingMs(deadlineMs, now()),
      shouldInterrupt,
      shouldStop,
    });
    created = existsSync(child);
    if (!attached.ok) {
      if ("stop" in attached) {
        return fail({ ok: false, stop: attached.stop });
      }
      return fail({ ok: false, detail: attached.detail });
    }
    return { ok: true };
  } catch (error) {
    if (error instanceof IsolationStoppedError) {
      return fail({ ok: false, stop: error.stop });
    }
    const detail = error instanceof Error ? error.message : String(error);
    return fail({
      ok: false,
      detail: `Isolation could not complete: ${detail}`,
    });
  }
}
