import type { HostDeliveryInput, HostRunInput } from "./context.js";
import { pushReport, resumePointOf } from "./report.js";

/**
 * A human unblocked an escalated Ticket: it resumes, and the signal is taken
 * back. The sweep drives it; nothing here does.
 */
export async function handleResume(
  ticket: { key: string; project: string },
  input: HostDeliveryInput,
): Promise<void> {
  const before = await input.ledger.get(ticket.key);
  if (!before.ok || before.aggregate.state !== "escalated") {
    return;
  }
  const resumePoint = resumePointOf(before.aggregate);
  const taken = await input.ledger.resumeTicket(ticket.key);
  if (!taken.ok) {
    return;
  }
  // The signal is an instruction, not a state: left where it is, it resumes the
  // ticket again on every pass and an escalation never freezes anything.
  await input.tickets.clearResume?.(ticket.key);
  // The ledger counts the rounds; this resume is the latest one.
  const resumed = await input.ledger.get(ticket.key);
  const round = resumed.ok ? resumed.aggregate.resumes : 0;
  await pushReport(input, {
    event: "resumed",
    key: ticket.key,
    project: ticket.project,
    eventId: `${ticket.key}:resumed:${round}`,
    fields: { resume_point: resumePoint },
  });
}

export async function handleCancel(
  ticket: { key: string; project: string },
  input: HostDeliveryInput,
): Promise<void> {
  const before = await input.ledger.get(ticket.key);
  if (!before.ok) {
    return;
  }
  const state = before.aggregate.state;
  if (state === "cancelled") {
    // The ledger takes a second cancel as done already; the tracker was told
    // the first time, and that is what delivered this one.
    return;
  }
  if (state === "done") {
    // A finished ticket's issue closing is the tracker agreeing, not a
    // cancel arriving late — the Submission itself asked for that close.
    input.journal.append({ event: "skipped", key: ticket.key, state });
    return;
  }
  const cancelled = await input.conductor.cancel(ticket.key);
  if (!cancelled.ok) {
    if (cancelled.code === "point-of-no-return") {
      await pushReport(input, {
        event: "reject_late",
        key: ticket.key,
        project: ticket.project,
        // A closed issue stays closed: every later delivery is the same cancel.
        eventId: `${ticket.key}:reject_late:cancel`,
        fields: { reason: "Cancel arrived after the point of no return." },
      });
    }
    return;
  }
  await pushReport(input, {
    event: "cancelled",
    key: ticket.key,
    project: ticket.project,
    // A Ticket is cancelled once: the ledger refuses a second cancel and never re-admits the key.
    eventId: `${ticket.key}:cancelled`,
    fields: { state },
  });
}

export type CancelResult =
  | { ok: true }
  | {
      ok: false;
      code: "not-found" | "point-of-no-return" | "already-cancelled" | "done";
    };

export type ReleaseResult =
  | { ok: true; freed: boolean }
  | {
      ok: false;
      code: "not-found" | "illegal-transition";
      state?: string;
    };

/**
 * Drop a held unit by key — without waiting for the bail clock.
 *
 * `freed` is false when the Ticket was already free (running with no unit
 * held). Refused past `running`: those states hold no unit, or are past the
 * point a local release can undo.
 */
export async function releaseTicket(input: HostRunInput, key: string): Promise<ReleaseResult> {
  const got = await input.ledger.get(key);
  if (!got.ok) {
    return { ok: false, code: "not-found" };
  }
  const { aggregate } = got;
  const held = aggregate.state === "running" && aggregate.bail !== undefined;
  const released = await input.conductor.release(key);
  if (!released.ok) {
    if (released.code === "not-found") {
      return { ok: false, code: "not-found" };
    }
    return { ok: false, code: "illegal-transition", state: aggregate.state };
  }
  return { ok: true, freed: held };
}

/** Abandon one Ticket by key — the same path a `cancel` delivery takes. */
export async function cancelTicket(input: HostRunInput, key: string): Promise<CancelResult> {
  const got = await input.ledger.get(key);
  if (!got.ok) {
    return { ok: false, code: "not-found" };
  }
  const state = got.aggregate.state;
  if (state === "cancelled") {
    return { ok: false, code: "already-cancelled" };
  }
  if (state === "done") {
    return { ok: false, code: "done" };
  }
  await handleCancel({ key, project: got.aggregate.intention.project }, { ...input, reported: [] });
  const after = await input.ledger.get(key);
  if (after.ok && after.aggregate.state === "cancelled") {
    return { ok: true };
  }
  return { ok: false, code: "point-of-no-return" };
}
