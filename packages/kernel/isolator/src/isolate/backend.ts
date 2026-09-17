import type { IsolationStop } from "./stop.js";

export type AttachResult =
  | { ok: true }
  | { ok: false; stop: IsolationStop }
  | { ok: false; detail: string };

/**
 * How Isolator produces the Child. The caller injects one; Isolator does not
 * choose a strategy or know git versus copy.
 */
export type IsolationBackend = {
  attach(input: {
    parent: string;
    child: string;
    /** Isolation id; a strategy may derive a branch or other label from it. */
    id?: string;
    timeoutMs: number;
    shouldInterrupt: () => boolean;
    shouldStop: () => IsolationStop | undefined;
  }): Promise<AttachResult>;
  /** Drop Isolation bookkeeping for an incomplete Child. Best-effort. */
  abort(input: { parent: string; child: string }): Promise<void>;
};
