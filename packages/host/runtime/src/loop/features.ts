import type { ProjectRunResult } from "@bluewombat/conductor";
import type {
  FeatureRef,
  FeatureStandard,
  TicketEntry,
  TicketStandard,
} from "@bluewombat/manager-kit";
import type {
  FeatureAdmission,
  FeatureAggregate,
  TicketAdmission,
  TicketState,
  TicketSummary,
} from "@bluewombat/work-ledger";
import { refreshWorkLine } from "./authority.js";
import type { HostDeliveryInput, HostRunInput } from "./context.js";
import {
  type CancelResult,
  cancelTicket,
  handleCancel as cancelTicketByKey,
  handleResume as resumeTicketByKey,
} from "./deliveries.js";
import { driveUntilBlocked } from "./drive.js";
import { pushReport } from "./report.js";

/** Where a Ticket is while it still counts against its Feature. */
const LIVE: ReadonlySet<TicketState> = new Set([
  "received",
  "running",
  "escalated",
  "integrating",
  "submitted",
  "merging",
]);

/** What a Feature says to its tracker: its own Thread, not a Ticket's. */
const TO = "features" as const;

/**
 * One Feature delivery: admit it, resume it, or abandon it. Nothing is driven
 * here — the sweep that follows advances every Project that has a Feature.
 */
export async function handleFeatureDelivery(
  input: HostDeliveryInput,
  payload: Record<string, unknown>,
): Promise<{ advance: boolean }> {
  const adapted = await input.features.adapt(payload);
  switch (adapted.outcome) {
    case "unavailable":
    case "interrupted":
      return { advance: false };
    case "invalid":
      // Said once per intention as written: the report is itself an edit of the
      // issue, and delivers it again.
      input.journal.append({ event: "invalid", key: adapted.key, reason: adapted.invalid.reason });
      await pushReport(
        input,
        {
          event: "invalid",
          key: adapted.key,
          project: adapted.project,
          eventId: `${adapted.key}:invalid:${adapted.fingerprint}`,
          fields: { reason: adapted.invalid.reason },
        },
        TO,
      );
      return { advance: true };
    case "converted":
      break;
  }

  const feature = adapted.feature;
  // Poll snapshots have no labeled edge: a resume signal on an escalated upsert
  // is the same instruction as an explicit resume intent.
  if (feature.intent === "upsert" && input.features.signalsResume?.(payload) === true) {
    const before = await input.ledger.getFeature(feature.key);
    if (before.ok && before.aggregate.state === "escalated") {
      await resumeFeature(input, feature.key, feature.project);
      return { advance: true };
    }
  }
  switch (feature.intent) {
    case "resume":
      await resumeFeature(input, feature.key, feature.project);
      return { advance: true };
    case "cancel":
      await cancelFeatureFlow(input, feature.key);
      return { advance: true };
    case "upsert":
      await admitFeature(input, feature);
      return { advance: true };
  }
}

async function admitFeature(input: HostDeliveryInput, feature: FeatureStandard): Promise<void> {
  if (feature.intention === undefined) {
    return;
  }
  // Only a Feature that has not opened takes new words. After that every
  // delivery is the tracker echoing a report of ours, or a human talking
  // about work already made: nothing here restarts it.
  const before = await input.ledger.getFeature(feature.key);
  if (before.ok && before.aggregate.state !== "waiting") {
    input.journal.append({ event: "skipped", key: feature.key, state: before.aggregate.state });
    return;
  }
  const admission: FeatureAdmission = {
    key: feature.key,
    project: feature.project,
    fingerprint: feature.fingerprint,
    priority: feature.priority,
    intention: feature.intention,
    manager: feature.manager,
    external_id: feature.external_id,
    blocked_by: feature.blocked_by,
    merge_when_ready: feature.merge_when_ready,
    ...(feature.title === undefined ? {} : { title: feature.title }),
    ...(feature.source === undefined ? {} : { source: feature.source }),
  };
  await input.ledger.admitFeature(admission);
}

async function resumeFeature(
  input: HostDeliveryInput,
  key: string,
  project: string,
): Promise<void> {
  const resumed = await input.ledger.resumeFeature(key);
  if (!resumed.ok) {
    return;
  }
  // The signal is an instruction, not a state; left in place it resumes the
  // Feature again on every pass.
  await input.features.clearResume?.(key);
  const got = await input.ledger.getFeature(key);
  const round = got.ok ? got.aggregate.resumes : 0;
  await pushReport(
    input,
    {
      event: "resumed",
      key,
      project,
      eventId: `${key}:resumed:${round}`,
      fields: { resume_point: "integrating" },
    },
    TO,
  );
}

/**
 * Abandon a Feature: its Tickets that are not done are cancelled, its line is
 * dropped, and the Project is free for the next one.
 */
export async function cancelFeatureFlow(input: HostDeliveryInput, key: string): Promise<void> {
  const before = await input.ledger.getFeature(key);
  if (!before.ok) {
    return;
  }
  const feature = before.aggregate;
  if (feature.state === "cancelled") {
    return;
  }
  if (feature.state === "done") {
    // A done Feature's issue closing is the tracker agreeing, not a cancel.
    input.journal.append({ event: "skipped", key, state: feature.state });
    return;
  }
  for (const summary of await ticketsOf(input, feature)) {
    if (LIVE.has(summary.state)) {
      await cancelTicketByKey({ key: summary.key, project: summary.project }, input);
    }
  }
  if (feature.line !== undefined) {
    await input.tickets.dropLine?.(feature.line);
  }
  const cancelled = await input.ledger.cancelFeature(key);
  if (!cancelled.ok) {
    return;
  }
  await pushReport(
    input,
    {
      event: "cancelled",
      key,
      project: feature.intention.project,
      eventId: `${key}:cancelled`,
      fields: { state: feature.state },
    },
    TO,
  );
}

async function ticketsOf(
  input: HostDeliveryInput,
  feature: FeatureAggregate,
): Promise<TicketSummary[]> {
  const known = new Set(feature.tickets);
  return (await input.ledger.list()).filter((summary) => known.has(summary.key));
}

/**
 * Move a Project's Feature along by one step: open the next one that may open,
 * make its Tickets, close its line, or watch for the human who folds it.
 */
export async function advanceProject(
  input: HostDeliveryInput,
  project: string,
): Promise<ProjectRunResult | undefined> {
  let active = await input.ledger.activeFeatureOn(project);
  if (active === undefined) {
    await openNextFeature(input, project);
    active = await input.ledger.activeFeatureOn(project);
  }
  if (active === undefined) {
    return undefined;
  }
  const got = await input.ledger.getFeature(active.key);
  if (!got.ok) {
    return undefined;
  }
  switch (got.aggregate.state) {
    case "open":
      return await advanceOpenFeature(input, got.aggregate);
    case "submitted":
      await settleFeature(input, got.aggregate);
      return undefined;
    default:
      return undefined;
  }
}

function refOf(feature: FeatureAggregate): FeatureRef {
  const { intention } = feature;
  return {
    key: intention.key,
    external_id: intention.external_id ?? intention.key,
    project: intention.project,
    ...(intention.source === undefined ? {} : { source: intention.source }),
  };
}

/** The line a Feature's Tickets land on: `feature/<id>`, as one safe branch name. */
function lineOf(feature: FeatureAggregate): string {
  const id = feature.intention.external_id ?? feature.intention.key;
  return `feature/${id.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")}`;
}

function admissionOf(
  ticket: TicketStandard,
  feature: FeatureAggregate,
  among: ReadonlySet<string>,
): TicketAdmission {
  return {
    key: ticket.key,
    project: ticket.project,
    fingerprint: ticket.fingerprint,
    priority: ticket.priority,
    intention: ticket.intention,
    manager: ticket.manager,
    external_id: ticket.external_id,
    feature: feature.intention.key,
    blocked_by: ticket.blocked_by.filter((other) => among.has(other)),
    ...(feature.line === undefined ? {} : { line: feature.line }),
    ...(ticket.title === undefined ? {} : { title: ticket.title }),
    ...(ticket.source === undefined ? {} : { source: ticket.source }),
  };
}

/**
 * Open the next Feature that may: waiting, nothing blocking it, and every one
 * of its Tickets written. Until then it waits and nothing is made.
 */
async function openNextFeature(input: HostDeliveryInput, project: string): Promise<void> {
  const next = await input.ledger.nextFeature(project);
  if (next === undefined) {
    return;
  }
  const got = await input.ledger.getFeature(next.key);
  if (!got.ok) {
    return;
  }
  const feature = got.aggregate;
  const listed = await input.tickets.tickets(refOf(feature));
  if (listed.outcome !== "listed") {
    input.journal.append({ event: "tickets-unavailable", key: feature.intention.key });
    return;
  }
  const live = listed.tickets.filter((entry) => entry.open);
  if (live.length === 0 || !live.every((entry) => entry.task_ready)) {
    input.journal.append({
      event: "waiting",
      key: feature.intention.key,
      reason: live.length === 0 ? "it has no Ticket yet" : "a Ticket is not ready yet",
    });
    return;
  }

  const target = input.workLine.target;
  let line: string | undefined;
  if (
    input.authority !== undefined &&
    input.tickets.openLine !== undefined &&
    target !== undefined
  ) {
    line = lineOf(feature);
    const made = await input.tickets.openLine({ line, from: target });
    if (made.outcome === "unavailable") {
      return;
    }
    if (made.outcome === "refused") {
      input.journal.append({
        event: "line-refused",
        key: feature.intention.key,
        reason: made.reason,
      });
      await pushReport(
        input,
        {
          event: "progress",
          key: feature.intention.key,
          project,
          eventId: `${feature.intention.key}:line-refused:${made.reason}`,
          fields: { summary: `Its line could not be opened: ${made.reason}` },
        },
        TO,
      );
      return;
    }
  }

  const among = new Set(live.map((entry) => entry.ticket.key));
  const opened = await input.ledger.openFeature({
    key: feature.intention.key,
    ...(line === undefined ? {} : { line }),
    tickets: [...among],
  });
  if (!opened.ok) {
    return;
  }
  const withLine: FeatureAggregate = { ...feature, ...(line === undefined ? {} : { line }) };
  for (const entry of live) {
    await input.ledger.admit(admissionOf(entry.ticket, withLine, among));
  }
  input.journal.append({
    event: "feature-opened",
    key: feature.intention.key,
    ...(line === undefined ? {} : { line }),
    tickets: live.length,
  });
  input.trace(`feature    ${feature.intention.key} opened with ${live.length} ticket(s)`);
  await pushReport(
    input,
    {
      event: "accepted",
      key: feature.intention.key,
      project,
      eventId: `${feature.intention.key}:accepted:${feature.intention.fingerprint}`,
      fields: { priority: feature.intention.priority },
    },
    TO,
  );
  for (const entry of live) {
    await pushReport(input, {
      event: "accepted",
      key: entry.ticket.key,
      project,
      eventId: `${entry.ticket.key}:accepted:${entry.ticket.fingerprint}`,
      fields: { priority: entry.ticket.priority },
    });
  }
}

/**
 * Bring the work line copy onto the line the next unit is made from. Without an
 * Authority the work line is the operator's and nothing is fetched.
 */
async function refreshOnto(input: HostDeliveryInput, branch: string | undefined): Promise<boolean> {
  if (input.authority === undefined || branch === undefined) {
    return true;
  }
  const refreshed = await refreshWorkLine({
    workLineStable: input.workLine.stable,
    workLineTarget: branch,
    refreshArgv: input.options.authority?.refreshArgv ?? [],
    timeoutMs: input.options.timeoutMs,
    env: input.workLine.env,
  });
  if (!refreshed.ok) {
    input.journal.append({
      event: "refresh",
      outcome: "failed",
      target: branch,
      ...(refreshed.detail === undefined ? {} : { detail: refreshed.detail }),
    });
    input.trace(
      `work line  cannot fast-forward onto ${branch}, so nothing started. ${refreshed.detail ?? ""}`,
    );
    return false;
  }
  input.journal.append({ event: "refresh", outcome: "ok", target: branch });
  return true;
}

/**
 * What the tracker says of the Tickets of an open Feature: an edit, a human's
 * resume, a Ticket closed under our feet. A Ticket that joined after the
 * Feature opened is not part of it.
 */
async function syncTickets(input: HostDeliveryInput, feature: FeatureAggregate): Promise<void> {
  const listed = await input.tickets.tickets(refOf(feature));
  if (listed.outcome !== "listed") {
    return;
  }
  const known = new Set(feature.tickets);
  for (const entry of listed.tickets) {
    if (!known.has(entry.ticket.key)) {
      continue;
    }
    await syncTicket(input, feature, entry, known);
  }
}

async function syncTicket(
  input: HostDeliveryInput,
  feature: FeatureAggregate,
  entry: TicketEntry,
  known: ReadonlySet<string>,
): Promise<void> {
  const { ticket } = entry;
  const current = await input.ledger.get(ticket.key);
  if (!current.ok) {
    return;
  }
  const state = current.aggregate.state;
  if (!entry.open) {
    if (LIVE.has(state)) {
      await cancelTicketByKey({ key: ticket.key, project: ticket.project }, input);
    }
    return;
  }
  // Only a Ticket that has not started takes the new words: the tracker's
  // fingerprint moves with every comment, and a unit in flight is not rewritten.
  if (state === "received" && current.aggregate.intention.fingerprint !== ticket.fingerprint) {
    await input.ledger.admit(admissionOf(ticket, feature, known));
  }
  if (entry.resume && state === "escalated") {
    await resumeTicketByKey({ key: ticket.key, project: ticket.project }, input);
  }
}

async function advanceOpenFeature(
  input: HostDeliveryInput,
  feature: FeatureAggregate,
): Promise<ProjectRunResult | undefined> {
  const project = feature.intention.project;
  await syncTickets(input, feature);

  const held = await input.ledger.activeOn(project);
  if (held?.state === "escalated") {
    return undefined;
  }
  const refreshed = await refreshOnto(input, feature.line ?? input.workLine.target);
  if (!refreshed) {
    return undefined;
  }

  let tickets = await ticketsOf(input, feature);
  let run: ProjectRunResult | undefined;
  let pending = tickets.find((summary) => LIVE.has(summary.state));
  // A Ticket that landed moved the line: the next one is cut from where it is
  // now, in this same pass, not a poll later.
  while (pending !== undefined) {
    run = await driveUntilBlocked(input, project, pending.key);
    tickets = await ticketsOf(input, feature);
    pending = tickets.find((summary) => LIVE.has(summary.state));
    const interrupted = input.options.interruptFlag?.interrupted === true;
    if (
      run.outcome !== "done" ||
      interrupted ||
      pending === undefined ||
      !(await refreshOnto(input, feature.line ?? input.workLine.target))
    ) {
      break;
    }
  }

  await reportLanded(input, feature, tickets);
  const settled = tickets.every(
    (summary) => summary.state === "done" || summary.state === "cancelled",
  );
  if (settled && tickets.length > 0) {
    await closeFeature(input, feature, tickets);
    return run;
  }
  if (run?.outcome === "idle" && tickets.some((summary) => summary.state === "received")) {
    await escalateFeature(
      input,
      feature,
      "No Ticket can start: each waits on a Ticket that is not done.",
    );
  }
  return run;
}

/** One `progress` per Ticket that landed, in the words the tracker already has. */
async function reportLanded(
  input: HostDeliveryInput,
  feature: FeatureAggregate,
  tickets: TicketSummary[],
): Promise<void> {
  const total = feature.tickets.length;
  const done = tickets.filter((summary) => summary.state === "done");
  for (const [at, summary] of done.entries()) {
    const got = await input.ledger.get(summary.key);
    const title = got.ok ? (got.aggregate.intention.title ?? summary.key) : summary.key;
    await pushReport(
      input,
      {
        event: "progress",
        key: feature.intention.key,
        project: feature.intention.project,
        eventId: `${feature.intention.key}:landed:${summary.key}`,
        fields: { summary: `Landed ${at + 1} of ${total}: ${title}` },
      },
      TO,
    );
  }
}

async function escalateFeature(
  input: HostDeliveryInput,
  feature: FeatureAggregate,
  report: string,
): Promise<void> {
  const escalated = await input.ledger.escalateFeature({ key: feature.intention.key, report });
  if (!escalated.ok) {
    return;
  }
  const got = await input.ledger.getFeature(feature.intention.key);
  const round = got.ok ? got.aggregate.resumes : 0;
  input.trace(`feature    ${feature.intention.key} escalated: ${report}`);
  await pushReport(
    input,
    {
      event: "escalated",
      key: feature.intention.key,
      project: feature.intention.project,
      eventId: `${feature.intention.key}:escalated:${round}`,
      fields: { reason: report, stage: "submitting" },
    },
    TO,
  );
}

/**
 * Every Ticket has landed: the line goes to the Authority. With none, the work
 * is already in the work line and the Feature is done.
 */
async function closeFeature(
  input: HostDeliveryInput,
  feature: FeatureAggregate,
  tickets: TicketSummary[],
): Promise<void> {
  const key = feature.intention.key;
  const project = feature.intention.project;
  if (!tickets.some((summary) => summary.state === "done")) {
    await escalateFeature(input, feature, "Every Ticket was abandoned, so nothing was made.");
    return;
  }
  if (input.authority === undefined || feature.line === undefined) {
    await input.ledger.markFeatureSubmitted({ key, reference: "local" });
    await input.ledger.markFeatureDone(key);
    await reportDone(input, feature, undefined, undefined);
    return;
  }
  if (feature.submission !== undefined) {
    await input.ledger.markFeatureSubmitted({ key, reference: feature.submission.reference });
    return;
  }
  const target = input.workLine.target;
  if (target === undefined) {
    return;
  }
  const submitted = await input.authority.submit({
    key,
    project,
    ref: key,
    branch: feature.line,
    target,
    workspace: input.workLine.stable,
    ...(feature.intention.title === undefined ? {} : { title: feature.intention.title }),
    intention: feature.intention.intention,
  });
  if (submitted.outcome === "unavailable") {
    return;
  }
  if (submitted.outcome === "refused") {
    await escalateFeature(input, feature, submitted.reason);
    return;
  }
  await input.ledger.markFeatureSubmitted({ key, reference: submitted.reference });
  await pushReport(
    input,
    {
      event: "submitted",
      key,
      project,
      eventId: `${key}:submitted:${submitted.reference}`,
      fields: { reference: submitted.reference },
    },
    TO,
  );
}

/**
 * The line is with the Authority. If the Feature merges by itself, the checks
 * decide; otherwise a human folds it and the system waits, starting nothing.
 */
async function settleFeature(input: HostDeliveryInput, feature: FeatureAggregate): Promise<void> {
  const submission = feature.submission;
  if (submission === undefined || input.authority === undefined || feature.line === undefined) {
    return;
  }
  const key = feature.intention.key;
  if (!feature.intention.merge_when_ready) {
    const settled =
      (await input.tickets.settled?.({ reference: submission.reference })) ?? "unavailable";
    if (settled === "folded") {
      await input.ledger.markFeatureDone(key);
      await reportDone(input, feature, submission.reference, undefined);
    } else if (settled === "closed") {
      await escalateFeature(
        input,
        feature,
        `The Submission ${submission.reference} was closed without being folded.`,
      );
    }
    return;
  }
  if (!(await refreshOnto(input, feature.line))) {
    return;
  }
  const judged = await input.transformers.implement({
    id: `${key}:judgement`,
    context: key,
    stage: "assembly",
    produce: false,
    intention: feature.intention.intention,
    workspace: input.workLine.stable,
  });
  if (judged.outcome === "interrupted" || judged.outcome === "invalid-invocation") {
    return;
  }
  if (judged.outcome === "escalated") {
    const last = judged.traces.at(-1);
    const why = last?.report ?? "The line was refused, with no reason given.";
    await escalateFeature(
      input,
      feature,
      last?.refusedBy === undefined ? why : `${last.refusedBy}: ${why}`,
    );
    return;
  }
  const folded = await input.authority.fold({ reference: submission.reference });
  if (folded.outcome === "unavailable") {
    return;
  }
  if (folded.outcome === "conflict") {
    await escalateFeature(input, feature, folded.reason);
    return;
  }
  await input.ledger.markFeatureDone(key, { reference: folded.reference });
  await reportDone(input, feature, submission.reference, folded.reference);
}

async function reportDone(
  input: HostDeliveryInput,
  feature: FeatureAggregate,
  reference: string | undefined,
  integrationReference: string | undefined,
): Promise<void> {
  const key = feature.intention.key;
  input.trace(`feature    ${key} done`);
  await pushReport(
    input,
    {
      event: "done",
      key,
      project: feature.intention.project,
      eventId: `${key}:done`,
      fields: {
        ...(reference === undefined || reference === "local" ? {} : { reference }),
        ...(integrationReference === undefined
          ? {}
          : { integration_reference: integrationReference }),
      },
    },
    TO,
  );
}

/** Abandon a Feature or a Ticket by key: whichever the ledger knows. */
export async function cancelKey(input: HostRunInput, key: string): Promise<CancelResult> {
  const feature = await input.ledger.getFeature(key);
  if (!feature.ok) {
    return await cancelTicket(input, key);
  }
  if (feature.aggregate.state === "cancelled") {
    return { ok: false, code: "already-cancelled" };
  }
  if (feature.aggregate.state === "done") {
    return { ok: false, code: "done" };
  }
  await cancelFeatureFlow({ ...input, reported: [] }, key);
  return { ok: true };
}
