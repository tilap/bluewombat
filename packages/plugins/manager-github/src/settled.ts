import { payloadHasLabel } from "./labels.js";
import type { StateLabels } from "./state-labels.js";

/** The states that end a Ticket: nothing more is done for it unless resumed. */
const SETTLED_STATES = ["done", "cancelled"] as const;

/**
 * Whether the tracker already says this issue reached an end — the state
 * labels of `done` or `cancelled` — and nobody asked to resume it.
 *
 * The WorkLedger is the truth; this is the tracker's own memory read as a
 * guard for when the ledger is gone, so a fresh one neither rebuilds merged
 * work nor takes up an abandoned issue again. The resume label still resumes.
 */
export function settledAlready(
  payload: Record<string, unknown>,
  labels: StateLabels,
  resume: string,
): boolean {
  return (
    SETTLED_STATES.some((state) => payloadHasLabel(payload, labels[state])) &&
    !payloadHasLabel(payload, resume)
  );
}
