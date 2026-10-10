import { type ConductorMoment, type ProjectRunResult, subjectOf } from "@bluewombat/conductor";
import type { EventFields, EventName } from "@bluewombat/manager-kit";
import type { EscalationKind, FeatureAggregate } from "@bluewombat/work-ledger";
import type { HostDeliveryInput } from "./context.js";
import type { Journal } from "./journal.js";

/** Conductor's and Implementer's own defaults, said here so a counter reads right without a config key. */
const DEFAULT_MAX_REFUSALS = 3;
const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * A moment inside a pass, said to the tracker as it happens. Each is said
 * once: the id names the fact, and a pass that sees it again says nothing.
 */
export async function reportMoment(
  input: HostDeliveryInput,
  moment: ConductorMoment,
): Promise<void> {
  const got = await input.ledger.get(moment.key);
  if (!got.ok) {
    return;
  }
  const { aggregate } = got;
  const key = aggregate.intention.key;
  const project = aggregate.intention.project;
  switch (moment.kind) {
    case "planned":
      if (aggregate.plan !== undefined) {
        await pushReport(input, plannedReport(key, project, aggregate.plan));
      }
      return;
    case "subtask-integrated": {
      // What landed, in the Plan's own headline: the sentence a person waits
      // for. The counters that used to sit under it said the same thing worse.
      const landed = aggregate.plan?.subtasks.find((subtask) => subtask.id === moment.subtaskId);
      const what = landed === undefined ? moment.subtaskId : subjectOf(landed.intention);
      await pushReport(input, {
        event: "progress",
        key,
        project,
        fields: { summary: `Landed ${moment.integrated} of ${moment.total}: ${what}` },
        eventId: `${key}:integrated:${moment.subtaskId}`,
      });
      return;
    }
    case "submitted":
      await pushReport(input, {
        event: "submitted",
        key,
        project,
        fields: { reference: moment.reference },
        eventId: `${key}:submitted:${moment.reference}`,
      });
      return;
  }
}

function plannedReport(
  key: string,
  project: string,
  record: NonNullable<FeatureAggregate["plan"]>,
): Parameters<typeof pushReport>[1] {
  // One line a person can read per Subtask: its first sentence, and what it
  // waits on. The whole intention is in the ledger and on the pull request.
  const plan = record.subtasks
    .map((subtask, at) => {
      const after =
        subtask.depends_on.length === 0 ? "" : ` (after ${subtask.depends_on.join(", ")})`;
      return `${at + 1}. ${subjectOf(subtask.intention)}${after}`;
    })
    .join("\n");
  return {
    event: "planned",
    key,
    project,
    fields: { plan },
    // A feature is driven again on every pass while it waits for a verdict.
    // The Plan was made once; say it once.
    eventId: `${key}:planned:${record.planned_at}`,
  };
}

export async function reportAfterRun(
  input: HostDeliveryInput,
  run: ProjectRunResult,
  aggregate: FeatureAggregate,
): Promise<void> {
  const key = aggregate.intention.key;
  const project = aggregate.intention.project;
  // The plan is said as it lands (reportMoment); this is the catch-up for a
  // plan made before a restart or while the tracker was down — same id, so a
  // manager that already has it says nothing.
  if (aggregate.plan !== undefined) {
    await pushReport(input, plannedReport(key, project, aggregate.plan));
  }
  switch (run.outcome) {
    case "done":
      // The Authority's own name for the work, when there was one. A local
      // fold has no name a reader of the tracker could open, and the path of
      // this machine's directory is the operator's layout, not a reference.
      await pushReport(input, {
        event: "done",
        key,
        project,
        fields: {
          ...(aggregate.submission === undefined
            ? {}
            : { reference: aggregate.submission.reference }),
          ...(aggregate.integration_reference === undefined
            ? {}
            : { integration_reference: aggregate.integration_reference }),
        },
        eventId: `${key}:done`,
      });
      return;
    case "escalated":
      break;
    case "paused":
      await reportRefusal(input, aggregate);
      return;
    case "idle":
    case "refused":
      return;
  }
  const kind: EscalationKind = aggregate.escalation?.kind ?? "subtask";
  // One escalation per round and kind: a Feature escalates again only after a
  // human's `ready`, which is what the ledger counts. The Attempt count would
  // not do — a Plan refused twice has none.
  const eventId = escalationId(key, aggregate, kind);
  switch (kind) {
    case "plan":
      await pushReport(input, {
        event: "escalated",
        key,
        project,
        eventId,
        fields: {
          stage: "plan",
          // A refused Plan left its reason as `invalid`; a freeze for an
          // intention edited in flight left the ledger's sentence as the
          // escalation's report. Neither is "the Plan was refused" for the other.
          reason:
            aggregate.invalid?.reason ?? aggregate.escalation?.report ?? "The Plan was refused.",
        },
      });
      return;
    case "merging":
      await pushReport(input, {
        event: "escalated",
        key,
        project,
        eventId,
        fields: {
          stage: "merging",
          reason: "Integration into WorkLineStable escalated.",
        },
      });
      return;
    case "assembly":
      // The feature as a whole, which names no unit: reporting it as a Subtask
      // sends a reader to look at work that did not fail.
      await pushReport(input, {
        event: "escalated",
        key,
        project,
        eventId,
        fields: {
          stage: "integrating",
          reason: "The assembled feature was refused and no attempt is left.",
          ...(aggregate.escalation?.report === undefined
            ? {}
            : { trace: aggregate.escalation.report }),
        },
      });
      return;
    case "submitted":
      await pushReport(input, {
        event: "escalated",
        key,
        project,
        eventId,
        fields: {
          stage: "submitting",
          reason: submittedReason(aggregate, input.options.maxRefusals ?? DEFAULT_MAX_REFUSALS),
          ...((aggregate.escalation?.report ?? aggregate.submission?.last_report) === undefined
            ? {}
            : {
                trace: (aggregate.escalation?.report ??
                  aggregate.submission?.last_report) as string,
              }),
        },
      });
      return;
    case "subtask":
      await pushReport(input, {
        event: "escalated",
        key,
        project,
        eventId,
        fields: subtaskEscalation(input, aggregate),
      });
      return;
  }
}

/**
 * One escalation kind covers three stops: the offer refused before any
 * Submission existed (the Publisher could not push, the Authority would not
 * open one), a republish refused, and a judgement that sent it back once too
 * often. Say only what the ledger shows; the Trace says who refused and why.
 */
function submittedReason(aggregate: FeatureAggregate, maxRefusals: number): string {
  const submission = aggregate.submission;
  if (submission === undefined) {
    return "The work could not be submitted.";
  }
  // The refusal that stopped it is never recorded as one (open-conductor).
  return submission.refusals + 1 >= maxRefusals
    ? "The Submission was refused and no attempt is left."
    : "The Submission was refused.";
}

/** `<key>:escalated:<round>:<kind>[:<subtask>]` — the same escalation hashes the same after a restart. */
function escalationId(key: string, aggregate: FeatureAggregate, kind: EscalationKind): string {
  const round = aggregate.resumes ?? 0;
  const unit = kind === "subtask" ? `:${aggregate.escalation?.subtask_id ?? "unknown"}` : "";
  return `${key}:escalated:${round}:${kind}${unit}`;
}

/**
 * A Subtask escalation, for a person who was not there. The Plan's headline
 * says what was tried, the last Attempt says who refused it and why, the
 * count says whether more patience would have helped — and what resuming does,
 * because that is the only question left to the reader.
 */
function subtaskEscalation(input: HostDeliveryInput, aggregate: FeatureAggregate): EventFields {
  const id = aggregate.escalation?.subtask_id;
  const unit = id ?? "unknown";
  const planned = aggregate.plan?.subtasks.find((subtask) => subtask.id === id);
  const what = planned === undefined ? unit : subjectOf(planned.intention);
  // This round's Attempts only: the budget is per round, and a Subtask resumed
  // once already spent three — "6 times of 3" counts against nothing.
  const round = aggregate.resumes ?? 0;
  const attempts = aggregate.attempts.filter(
    (attempt) => attempt.subtask_id === id && (attempt.round ?? 0) === round,
  );
  const last = [...attempts].reverse().find((attempt) => attempt.trace !== undefined)?.trace;
  const max = input.options.builder?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const by = last?.refusedBy ?? "a Gate";

  let why: string;
  if (last?.ended === "fail-blocking") {
    why = `${by} refused it outright, and no further attempt could change that`;
  } else if (last?.ended === "fail-retryable") {
    const reports = attempts.map((attempt) => attempt.trace?.report);
    const same = reports.every((report) => report === last.report);
    const times = attempts.length === 1 ? "once" : `${attempts.length} times of ${max}`;
    const pattern =
      attempts.length < 2
        ? ""
        : same
          ? ", for the same reason each time"
          : ", each time differently";
    const which = round === 0 ? "" : `, in round ${round + 1}`;
    why = `${by} refused it ${times}${pattern}${which}`;
  } else {
    why = (aggregate.escalation?.report ?? "it escalated").replace(/\.$/, "");
  }
  const resume = `On resume, ${unit} starts again from zero; what already landed is kept.`;

  const fields: EventFields = {
    stage: "unit",
    reason: `${what} — ${why}. ${resume}`,
    // The refusal in the refuser's own words; the ledger's sentence when no
    // Attempt left one (a fold conflict); the verdict alone for a record
    // written before reports were kept.
    trace: last?.report ?? aggregate.escalation?.report ?? last?.ended ?? "No Trace recorded.",
    unit,
  };
  if (attempts.length > 0) {
    fields.counters = { attempts: `${attempts.length} of ${max}` };
  }
  return fields;
}

/**
 * A refusal sent the work back to `assembly.fix` and a repair is on its way.
 * Between that and the next verdict the tracker would otherwise say nothing,
 * and a reader would take the silence for waiting.
 *
 * Two refusers write here: the Authority (`submission.last_report`, once there
 * is a Submission) and `assembly.validate` (`parked_refusal`, which can exist
 * before one does, or without an Authority at all). The parked one is fresher
 * when both are set, the same priority `open-conductor` gives it.
 */
async function reportRefusal(input: HostDeliveryInput, aggregate: FeatureAggregate): Promise<void> {
  if (aggregate.state !== "integrating") {
    return;
  }
  const max = input.options.maxRefusals ?? DEFAULT_MAX_REFUSALS;
  const parked = aggregate.parked_refusal;
  if (parked !== undefined) {
    const parkedRefusals = aggregate.parked_refusals ?? 0;
    const spent = (aggregate.submission?.refusals ?? 0) + parkedRefusals;
    await pushReport(input, {
      event: "progress",
      key: aggregate.intention.key,
      project: aggregate.intention.project,
      // Keyed on the parked count, not the shared total: a Submission refusal
      // in the same round would otherwise collide with this id.
      eventId: `${aggregate.intention.key}:refused:parked:${parkedRefusals}`,
      fields: {
        summary: `${parked.refused_by ?? "assembly.validate"} refused the assembled feature; a repair is on its way (refusal ${spent} of ${max}).`,
        stage: "integrating",
        trace: parked.report,
      },
    });
    return;
  }
  const submission = aggregate.submission;
  if (
    submission === undefined ||
    submission.last_report === undefined ||
    submission.refusals === 0
  ) {
    return;
  }
  await pushReport(input, {
    event: "progress",
    key: aggregate.intention.key,
    project: aggregate.intention.project,
    // One per refusal: the same round is driven again on every pass.
    eventId: `${aggregate.intention.key}:refused:${submission.refusals}`,
    fields: {
      // Who refused, what happens next, and how many refusals the Authority may
      // still send back before this escalates — in one sentence.
      summary: `${submission.last_refused_by ?? "The Authority"} refused the Submission; a repair is on its way (refusal ${submission.refusals} of ${max}).`,
      stage: "submitting",
      trace: submission.last_report,
    },
  });
}

export function resumePointOf(aggregate: FeatureAggregate): "planning" | "running" | "integrating" {
  switch (aggregate.escalation?.kind) {
    case "plan":
      return "planning";
    // What the ledger does on resumeReady, said in the same words.
    case "merging":
    case "assembly":
    case "submitted":
      return "integrating";
    case "subtask":
    case undefined:
      return "running";
  }
}

export async function pushReport(
  input: Pick<HostDeliveryInput, "manager" | "reported" | "journal"> & { said?: Set<string> },
  report: {
    event: EventName;
    key: string;
    project: string;
    fields: EventFields;
    eventId?: string;
  },
): Promise<void> {
  if (report.eventId !== undefined && input.said?.has(report.eventId)) {
    return;
  }
  // How long the tracker took, kept either way: a report is awaited where the
  // work is, and one that hung for minutes looked like nothing at all.
  const started = Date.now();
  const ok = await input.manager.report({
    event: report.event,
    key: report.key,
    project: report.project,
    fields: report.fields,
    ...(report.eventId === undefined ? {} : { eventId: report.eventId }),
  });
  const ms = Date.now() - started;
  if (!ok) {
    input.journal.append({ event: "report-declined", key: report.key, reported: report.event, ms });
    return;
  }
  input.reported.push(report.event);
  input.journal.append({ event: "reported", key: report.key, reported: report.event, ms });
  if (report.eventId !== undefined) {
    input.said?.add(report.eventId);
  }
}

/**
 * One Host line per Project we drove: the outcome, and a heartbeat while it waits.
 */
export function journalFeature(
  journal: Journal,
  outcome: string,
  aggregate: FeatureAggregate,
  said?: Set<string>,
): void {
  const key = aggregate.intention.key;
  // A Subtask held by a bail is driven again every poll until the clock (or a
  // release) frees it. One `held` line names the wait; repeating `ran paused`
  // every ten seconds is noise.
  if (
    outcome === "paused" &&
    aggregate.state === "running" &&
    aggregate.bail !== undefined &&
    aggregate.bail.expires_at > Date.now()
  ) {
    const seen = `journal:${key}:held:${aggregate.bail.expires_at}`;
    if (said?.has(seen)) {
      return;
    }
    said?.add(seen);
    journal.append({
      event: "held",
      key,
      until: aggregate.bail.expires_at,
      state: aggregate.state,
    });
    return;
  }
  journal.append({ event: "ran", key, outcome, state: aggregate.state });
  if (aggregate.state !== "submitted" || aggregate.submission === undefined) {
    return;
  }
  // A Submission is driven again on every pass while it waits. Its line is
  // written when it changes — the reference, or the count of refusals — not
  // every time the pass sees it again.
  const seen = `journal:${key}:submitted:${aggregate.submission.reference}:${aggregate.submission.refusals}`;
  if (said?.has(seen)) {
    return;
  }
  said?.add(seen);
  journal.append({
    event: "submitted",
    key,
    reference: aggregate.submission.reference,
    refusals: aggregate.submission.refusals,
  });
}
