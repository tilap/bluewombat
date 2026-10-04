import { payloadHasLabel } from "./labels.js";

/** The states that end a Feature: nothing more is done for it unless resumed. */
const SETTLED_STATES = ["done", "cancelled"] as const;

/**
 * Whether the tracker already says this issue reached an end — `done` or
 * `cancelled` under the state-label prefix — and nobody asked to resume it.
 *
 * The WorkLedger is the truth; this is the tracker's own memory read as a
 * guard for when the ledger is gone, so a fresh one neither rebuilds merged
 * work nor takes up an abandoned issue again. The ready label still resumes.
 */
export function settledAlready(
  payload: Record<string, unknown>,
  prefix: string,
  ready: string,
): boolean {
  return (
    SETTLED_STATES.some((state) => payloadHasLabel(payload, `${prefix}${state}`)) &&
    !payloadHasLabel(payload, ready)
  );
}
