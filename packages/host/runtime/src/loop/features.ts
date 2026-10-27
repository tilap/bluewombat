import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { DeliveryStore, DeliveryUnit, ProjectRunResult } from "@bluewombat/conductor";
import { pathSegment } from "@bluewombat/conductor";
import {
  CLI_NAME,
  type FeatureRef,
  type FeatureStandard,
  type TicketEntry,
  type TicketStandard,
} from "@bluewombat/manager-kit";
import type {
  FeatureAdmission,
  FeatureAggregate,
  TicketAdmission,
  TicketState,
  TicketSummary,
} from "@bluewombat/work-ledger";
import { publish, refreshWorkLine } from "./authority.js";
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
    // The label that leaves the feature-test check out is the one thing a human can still change: it is
    // honoured until the Feature is submitted, and read again by the check each time it runs.
    if (before.aggregate.intention.skip_feature_test !== feature.skip_feature_test) {
      const moved = await input.ledger.setFeatureSkipFeatureTest({
        key: feature.key,
        skip: feature.skip_feature_test,
      });
      if (moved.ok) {
        input.journal.append({
          event: "skip-feature-test",
          key: feature.key,
          skip: feature.skip_feature_test,
        });
        input.trace(
          `feature    ${feature.key} ${feature.skip_feature_test ? "now" : "no longer"} skips the feature-test check`,
        );
        return;
      }
    }
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
    ...(feature.skip_feature_test ? { skip_feature_test: true } : {}),
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
  if (input.featureDelivery !== undefined) {
    await rm(featureWorkspace(input.featureDelivery, key), { recursive: true, force: true });
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

/** What the tracker says of a Ticket beside its words. */
function marksOf(entry: TicketEntry): { noTests: boolean; featureTest: boolean } {
  return { noTests: entry.no_tests, featureTest: entry.featureTest === true };
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
  marks: { noTests: boolean; featureTest: boolean },
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
    // The Ticket that holds the acceptance suite writes the tests itself: none are written first.
    ...(marks.noTests || marks.featureTest ? { no_tests: true } : {}),
    ...(marks.featureTest ? { featureTest: true } : {}),
  };
}

/**
 * What is wrong with a Feature of a Project that proves its Features by a feature-test suite: it holds
 * no feature-test Ticket and is not marked to skip the check, holds several, or its feature-test Ticket may start
 * before the others have landed. Nothing: a Project without the check, or a Feature that skips it.
 */
function featureTestRefusal(
  input: HostDeliveryInput,
  feature: FeatureAggregate,
  live: readonly TicketEntry[],
): string | undefined {
  if (
    input.options.builder.featureTest === undefined ||
    feature.intention.skip_feature_test === true
  ) {
    return undefined;
  }
  const holding = live.filter((entry) => entry.featureTest);
  const head =
    "This Project proves each Feature by a feature tests, run once on the whole Feature.";
  if (holding.length === 0) {
    return `${head} The Feature has no feature-test Ticket and is not marked skip-feature-test: add the feature-test Ticket (the scenarios agreed with the operator, blocked by every other Ticket), or mark the Feature to skip the check.`;
  }
  if (holding.length > 1) {
    return `${head} The Feature holds ${holding.length} feature-test Tickets: it holds one, with all its scenarios.`;
  }
  const only = holding[0];
  const others = live.filter((entry) => !entry.featureTest).map((entry) => entry.ticket.key);
  const missing = others.filter((key) => !only?.ticket.blocked_by.includes(key));
  if (only !== undefined && missing.length > 0) {
    return `${head} The feature-test Ticket ${only.ticket.key} must be blocked by every other Ticket of the Feature, so that it lands last. It is not blocked by: ${missing.join(", ")}.`;
  }
  return undefined;
}

/** Whether a Feature still holds a feature-test Ticket that was not cancelled. */
async function holdsLiveFeatureTestTicket(
  input: HostDeliveryInput,
  feature: FeatureAggregate,
): Promise<boolean> {
  for (const key of feature.tickets) {
    const got = await input.ledger.get(key);
    if (
      got.ok &&
      got.aggregate.intention.featureTest === true &&
      got.aggregate.state !== "cancelled"
    ) {
      return true;
    }
  }
  return false;
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

  const refusal = featureTestRefusal(input, feature, live);
  if (refusal !== undefined) {
    input.journal.append({ event: "invalid", key: feature.intention.key, reason: refusal });
    await pushReport(
      input,
      {
        event: "invalid",
        key: feature.intention.key,
        project,
        eventId: `${feature.intention.key}:invalid:feature-test:${refusal}`,
        fields: { reason: refusal },
      },
      TO,
    );
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
    await input.ledger.admit(admissionOf(entry.ticket, withLine, among, marksOf(entry)));
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
    // A Feature's line that has not moved is brought up to the final branch
    // first, so its Tickets read the code as it now is.
    workLineBase: branch === input.workLine.target ? undefined : input.workLine.target,
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
  // The label that says no tests are written first is not in the words, so it moves no
  // fingerprint: it is compared on its own.
  const marks = marksOf(entry);
  const flagged = current.aggregate.intention.no_tests === true;
  const holdsFeatureTest = current.aggregate.intention.featureTest === true;
  if (
    state === "received" &&
    (current.aggregate.intention.fingerprint !== ticket.fingerprint ||
      flagged !== (marks.noTests || marks.featureTest) ||
      holdsFeatureTest !== marks.featureTest)
  ) {
    await input.ledger.admit(admissionOf(ticket, feature, known, marks));
  }
  // A Feature that is not put through the feature-test check has no use of the Ticket that holds it.
  if (feature.intention.skip_feature_test === true && marks.featureTest && LIVE.has(state)) {
    input.journal.append({
      event: "feature-test-ticket-cancelled",
      key: ticket.key,
      feature: feature.intention.key,
    });
    input.trace(
      `feature    ${feature.intention.key} skips the feature-test check: ticket ${ticket.key} is cancelled`,
    );
    await cancelTicketByKey({ key: ticket.key, project: ticket.project }, input);
    return;
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

  const limit = input.options.ticket.maxParallel ?? 1;
  // A Ticket waiting for a person holds its place. When every place is held
  // that way, nothing can move until someone answers.
  const holding = await input.ledger.activeTickets(project);
  if (holding.length >= limit && holding.every((summary) => summary.state === "escalated")) {
    return undefined;
  }

  // Nothing is taken if the line cannot be reached. Conductor refreshes it again
  // for each Ticket it cuts and aligns, which is what keeps a Ticket current
  // while others land; this is the check that starts nothing at all.
  if (!(await refreshOnto(input, feature.line ?? input.workLine.target))) {
    return undefined;
  }
  const run = await driveTickets(input, feature, project, limit);
  const tickets = await ticketsOf(input, feature);

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

/** Where a Ticket is while Host has something to drive it through. */
const DRIVEN: ReadonlySet<TicketState> = new Set([
  "running",
  "integrating",
  "submitted",
  "merging",
]);

/**
 * Work the Tickets of an open Feature, up to `limit` at a time.
 *
 * Each place is a worker: it drives a Ticket the Project already holds, else
 * takes the next one that may start, and goes on to another when its own is
 * done or is only waiting for the outside. A Ticket waiting on a check holds a
 * place but not a worker, so the others do not wait with it. With a limit of 1
 * this is one Ticket after the other.
 */
async function driveTickets(
  input: HostDeliveryInput,
  feature: FeatureAggregate,
  project: string,
  limit: number,
): Promise<ProjectRunResult | undefined> {
  // Once, before anything runs at the same time: it clears what a dead process
  // left, which must not be done under a Ticket that is being driven.
  await input.conductor.reconcile(project);
  const interrupted = (): boolean => input.options.interruptFlag?.interrupted === true;
  const queue = (await ticketsOf(input, feature))
    .filter((summary) => DRIVEN.has(summary.state))
    .map((summary) => summary.key);
  let last: ProjectRunResult | undefined;

  const worker = async (): Promise<void> => {
    while (!interrupted()) {
      const key = queue.shift() ?? (await input.conductor.claimNext(project))?.key;
      if (key === undefined) {
        return;
      }
      const run = await driveUntilBlocked(input, project, key, true);
      last = run;
      // A refusal is about the run, not the Ticket: the next one would meet it too.
      if (run.outcome === "refused") {
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, limit) }, worker));

  if (last === undefined && (await input.ledger.activeTickets(project)).length === 0) {
    const waiting = (await ticketsOf(input, feature)).some((s) => s.state === "received");
    // Nothing held and nothing could start: what remains waits on what cannot finish.
    return waiting ? { outcome: "idle" } : undefined;
  }
  return last;
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
  /** Where the line stopped and who refused it, when the caller knows. */
  origin:
    | { kind: "assembly" | "submitted"; refusedBy?: string | undefined }
    | undefined = undefined,
): Promise<void> {
  const escalated = await input.ledger.escalateFeature({
    key: feature.intention.key,
    report,
    ...(origin === undefined ? {} : { kind: origin.kind }),
    ...(origin?.refusedBy === undefined ? {} : { refusedBy: origin.refusedBy }),
  });
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
      // The assembled line refused by a check is not a Submission refused: say which it was.
      fields: { reason: report, stage: origin?.kind === "assembly" ? "integrating" : "submitting" },
    },
    TO,
  );
}

/** Where a Feature's own work is done: apart from every Ticket's workspace, which Host clears of strays. */
function featureWorkspace(
  delivery: NonNullable<HostDeliveryInput["featureDelivery"]>,
  key: string,
) {
  return join(delivery.workspaces, pathSegment(key));
}

/** Where the Feature's work is, and where it goes: the Feature stands where a Ticket stood, the final line where the Feature's was. */
function featureUnit(
  input: HostDeliveryInput,
  delivery: NonNullable<HostDeliveryInput["featureDelivery"]>,
  feature: FeatureAggregate,
): DeliveryUnit {
  return {
    key: feature.intention.key,
    intention: feature.intention.intention,
    title: feature.intention.title,
    noun: "feature",
    workspace: featureWorkspace(delivery, feature.intention.key),
    // The Gates read the published branch, and the copy of the Feature's line is on it.
    judgeWorkspace: input.workLine.stable,
    target: input.workLine.target ?? "",
    line: delivery.targetStable,
  };
}

/** What a Feature's delivery reads of it, and how the Feature keeps what the delivery decides. */
function featureStore(input: HostDeliveryInput, feature: FeatureAggregate): DeliveryStore {
  const key = feature.intention.key;
  const failed = (result: { ok: boolean }): ProjectRunResult | undefined =>
    result.ok ? undefined : { outcome: "refused", code: "illegal-transition" };
  return {
    async read() {
      const got = await input.ledger.getFeature(key);
      if (!got.ok) {
        return undefined;
      }
      const aggregate = got.aggregate;
      const parked = aggregate.parked_refusal;
      const report = parked?.report ?? aggregate.submission?.last_report;
      const refusedBy = parked?.refused_by ?? aggregate.submission?.last_refused_by;
      return {
        sentBack: report === undefined ? undefined : { report, refusedBy },
        spent:
          (aggregate.submission?.refusals ?? 0) +
          (aggregate.parked_refusals ?? 0) +
          (aggregate.submission?.realigns ?? 0),
        submission:
          aggregate.submission === undefined
            ? undefined
            : { reference: aggregate.submission.reference },
      };
    },
    async freeze(frozen) {
      await escalateFeature(
        input,
        feature,
        frozen.report ?? "The line was stopped, with no reason given.",
        { kind: frozen.kind, refusedBy: frozen.refusedBy },
      );
      return { outcome: "escalated", key };
    },
    async park(why) {
      return failed(
        await input.ledger.recordFeatureParkedRefusal({
          key,
          report: why.report,
          ...(why.refusedBy === undefined ? {} : { refusedBy: why.refusedBy }),
        }),
      );
    },
    async unpark() {
      return failed(await input.ledger.clearFeatureParkedRefusal(key));
    },
    async refuse(why) {
      return failed(
        await input.ledger.recordFeatureRefusal({
          key,
          report: why.report,
          ...(why.refusedBy === undefined ? {} : { refusedBy: why.refusedBy }),
        }),
      );
    },
    async realign() {
      return failed(await input.ledger.recordFeatureRealign(key));
    },
  };
}

/**
 * Every Ticket has landed: the line is brought up to date with the one it is
 * folded into, checked, and put in front of the Authority. With none, the work
 * is already in the work line and the Feature is done.
 *
 * It is delivered the way a Ticket is — see `openDelivery` — with the final line
 * merged into the Feature's work, its own checks run on the result, and a fix
 * when something refuses it. Only where the work is offered differs: the line
 * is pushed under its own name rather than a name made for it.
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
  if (
    input.options.builder.featureTest !== undefined &&
    feature.intention.skip_feature_test !== true &&
    !(await holdsLiveFeatureTestTicket(input, feature))
  ) {
    await escalateFeature(
      input,
      feature,
      "This Feature is not marked skip-feature-test and holds no feature-test Ticket: it was cancelled while the Feature skipped the check, and the mark was taken off since. Mark the Feature skip-feature-test again to leave the check out.",
    );
    return;
  }
  if (input.authority === undefined || feature.line === undefined) {
    await input.ledger.markFeatureSubmitted({ key, reference: "local" });
    await input.ledger.markFeatureDone(key);
    await reportDone(input, feature, undefined, undefined);
    return;
  }
  const delivery = input.featureDelivery;
  const target = input.workLine.target;
  const publishArgv = input.options.authority?.publishArgv;
  if (delivery === undefined || target === undefined || publishArgv === undefined) {
    return;
  }
  const unit = featureUnit(input, delivery, feature);
  const clean = async (): Promise<void> => {
    await rm(unit.workspace, { recursive: true, force: true });
  };

  // The Feature's work is cut from its line the way a Ticket's is, once; a
  // pass that sent it to the fix finds it where it was left. A resume is the
  // one time the line may have moved under it, by a person: what it gained is
  // then merged into the work, which keeps what it holds.
  if (existsSync(unit.workspace)) {
    if (feature.workspace_stale === true && !(await takeInLine(input, feature, unit))) {
      return;
    }
  } else {
    if (!(await refreshOnto(input, feature.line))) {
      return;
    }
    const isolated = await input.transformers.isolate({
      id: `${key}:close`,
      context: key,
      parent: input.workLine.stable,
      child: unit.workspace,
      durationMs: input.options.timeoutMs,
    });
    if (isolated.outcome !== "isolated") {
      // Nothing was spent: the next pass tries again.
      await clean();
      return;
    }
    // The checks run here, so it is prepared the way a Ticket's workspace is.
    const warmed = await delivery.warm?.prepare({
      workspace: unit.workspace,
      durationMs: delivery.warm.durationMs,
    });
    if (warmed !== undefined && warmed.outcome !== "warmed") {
      await clean();
      return;
    }
  }
  if (feature.workspace_stale === true) {
    await input.ledger.markFeatureWorkspaceCurrent(key);
  }
  const prepared = await delivery.delivery.prepare(unit, featureStore(input, feature));
  if (prepared !== "ready") {
    return;
  }

  // Offer it. What was made in the workspace goes back into the Feature's line
  // and the line is pushed under its own name, which is where the Authority
  // reads it and where its Submission is.
  const folded = await input.transformers.integrate({
    id: `${key}:close`,
    context: key,
    parent: input.workLine.stable,
    child: unit.workspace,
    durationMs: input.options.timeoutMs,
    subject: `Merge ${target} into ${feature.line}`,
    mergeSubject: `Merge ${target} into ${feature.line}`,
  });
  if (folded.outcome === "interrupted") {
    return;
  }
  if (folded.outcome !== "integrated") {
    await escalateFeature(input, feature, "The Feature's work could not be folded into its line.");
    return;
  }
  const published = await publish({
    argv: publishArgv,
    cwd: input.workLine.stable,
    id: key,
    ref: feature.line,
    target,
    timeoutMs: input.options.timeoutMs,
    env: input.workLine.env,
  });
  if (!published.ok) {
    await escalateFeature(input, feature, published.reason);
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
  await clean();
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
 * Bring what a resumed Feature's line gained since its work was cut into that
 * work, without discarding what the work holds (the fix's own commits, even
 * refused ones: a person may want them). Answers whether the pass goes on:
 * not when the line could not be reached or the merge was interrupted (the next
 * pass tries again), nor when it conflicts — that is for a person, and the
 * work is left as it was.
 */
async function takeInLine(
  input: HostDeliveryInput,
  feature: FeatureAggregate,
  unit: DeliveryUnit,
): Promise<boolean> {
  if (!(await refreshOnto(input, feature.line))) {
    return false;
  }
  const taken = await input.transformers.integrate({
    id: `${unit.key}:resume`,
    context: unit.key,
    parent: unit.workspace,
    child: input.workLine.stable,
    durationMs: input.options.timeoutMs,
    subject: "Work left when the Feature stopped",
    mergeSubject: `Merge ${feature.line} into the feature`,
  });
  switch (taken.outcome) {
    case "integrated":
      return true;
    case "interrupted":
      return false;
    case "conflict":
      await escalateFeature(
        input,
        feature,
        `The line ${feature.line} gained commits since the Feature's work was made, and they conflict with it: both changed the same places. The work was left as it was. Settle it on the line, or run \`${CLI_NAME} restart ${unit.key}\` to make the work again from the line, then resume.`,
        { kind: "assembly" },
      );
      return false;
    default:
      await escalateFeature(
        input,
        feature,
        `What the line ${feature.line} gained could not be merged into the Feature's work. The work was left as it was.`,
        { kind: "assembly" },
      );
      return false;
  }
}

/**
 * The line is with the Authority. If the Feature merges by itself, its gates
 * decide, and a line the target moved on from goes back to be brought up to
 * date, exactly as a Ticket does; otherwise a human folds it and the system
 * waits, starting nothing.
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
  const delivery = input.featureDelivery;
  if (delivery === undefined || !(await refreshOnto(input, feature.line))) {
    return;
  }
  const settled = await delivery.delivery.settle(
    featureUnit(input, delivery, feature),
    featureStore(input, feature),
  );
  if (!("folded" in settled)) {
    return;
  }
  await input.ledger.markFeatureDone(key, { reference: settled.reference });
  await reportDone(input, feature, submission.reference, settled.reference);
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

export type RestartResult =
  | { ok: true }
  | { ok: false; code: "not-found" }
  | { ok: false; code: "not-escalated"; state: string };

/**
 * Restart an escalated Feature with a fresh workspace: what it holds is removed
 * and the Feature is resumed, so the next pass cuts its work again from the
 * line and judges that. Nothing is said to the tracker and nothing is fetched.
 */
export async function restartFeature(input: HostRunInput, key: string): Promise<RestartResult> {
  const got = await input.ledger.getFeature(key);
  if (!got.ok) {
    return { ok: false, code: "not-found" };
  }
  if (got.aggregate.state !== "escalated") {
    return { ok: false, code: "not-escalated", state: got.aggregate.state };
  }
  if (input.featureDelivery !== undefined) {
    await rm(featureWorkspace(input.featureDelivery, key), { recursive: true, force: true });
  }
  const resumed = await input.ledger.resumeFeature(key);
  if (!resumed.ok) {
    return { ok: false, code: "not-escalated", state: got.aggregate.state };
  }
  input.journal.append({ event: "restarted", key });
  return { ok: true };
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
