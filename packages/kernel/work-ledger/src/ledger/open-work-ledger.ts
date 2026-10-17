import type { PersistencePort } from "../persist/port.js";
import type {
  Aggregate,
  AttemptRecord,
  EscalationKind,
  RefusalCode,
  Summary,
  TicketAggregate,
  TicketIntention,
  TicketState,
  TicketSummary,
  TraceRecord,
} from "../records.js";
import { isFeatureAggregate, isFeatureSummary } from "../records.js";
import { type FeatureCommands, openFeatureCommands } from "./feature-commands.js";
import { type CommandRefused, type CommandResult, refused } from "./results.js";

const DEFAULT_BAIL_DURATION_MS = 3_600_000;

const ACTIVE_STATES: ReadonlySet<TicketState> = new Set([
  "running",
  "escalated",
  "integrating",
  "submitted",
  "merging",
]);

const IN_FLIGHT: ReadonlySet<TicketState> = new Set(["running", "integrating", "submitted"]);

export type TicketAdmission = TicketIntention;

export type { CommandOk, CommandRefused, CommandResult } from "./results.js";

export type ClaimResult = { ok: true; key: string } | { ok: true; empty: true } | CommandRefused;

export type GetResult = { ok: true; aggregate: TicketAggregate } | { ok: false; code: "not-found" };

export type OpenWorkLedgerOptions = {
  persist: PersistencePort;
  now?: () => number;
  bailDurationMs?: number;
};

export type EscalateInput = {
  key: string;
  kind: EscalationKind;
  /** Why it stopped. Kept so the person who reads the escalation is told. */
  report?: string;
};

export type RecordAttemptInput = {
  key: string;
  number: number;
  trace?: TraceRecord;
};

export type DeclareWorkspaceInput = {
  key: string;
  path: string;
};

export type DeclaredWorkspace = {
  key: string;
  path: string;
};

export type WorkLedger = FeatureCommands & {
  admit(ticket: TicketAdmission): Promise<CommandResult>;
  recordInvalid(input: {
    key: string;
    project: string;
    code: string;
    reason: string;
    /** Of what was received, so the same invalid intention is known as such. */
    fingerprint?: string;
    priority?: number;
  }): Promise<CommandResult>;
  claim(project: string): Promise<ClaimResult>;
  recordAttempt(input: RecordAttemptInput): Promise<CommandResult>;
  /** The unit starts: from here the Ticket holds a lease until it ends. */
  startUnit(key: string): Promise<CommandResult>;
  /** The unit passed its Gates: the work is assembled and judged next. */
  markIntegrating(key: string): Promise<CommandResult>;
  markSubmitted(input: { key: string; reference: string }): Promise<CommandResult>;
  recordRefusal(input: { key: string; report: string; refusedBy?: string }): Promise<CommandResult>;
  recordParkedRefusal(input: {
    key: string;
    report: string;
    refusedBy?: string;
  }): Promise<CommandResult>;
  clearParkedRefusal(key: string): Promise<CommandResult>;
  markMerging(key: string): Promise<CommandResult>;
  markDone(key: string, input?: { reference?: string | undefined }): Promise<CommandResult>;
  escalate(input: EscalateInput): Promise<CommandResult>;
  resumeTicket(key: string): Promise<CommandResult>;
  cancel(key: string): Promise<CommandResult>;
  declareWorkspace(input: DeclareWorkspaceInput): Promise<CommandResult>;
  clearWorkspace(key: string): Promise<CommandResult>;
  /** The stage made before the producer is complete in the declared workspace. */
  markFirstStageDone(key: string): Promise<CommandResult>;
  expireBail(key: string): Promise<CommandResult>;
  /**
   * Drop a held unit without waiting for the bail clock. Unlike an expired bail it spends no
   * Attempt: the unit stopped on purpose and recorded the Attempts it finished.
   */
  releaseBail(key: string): Promise<CommandResult>;
  renewBail(key: string): Promise<CommandResult>;
  get(key: string): Promise<GetResult>;
  /** Every known Ticket, whatever its state. */
  list(): Promise<TicketSummary[]>;
  /** Every Ticket mid-flight, whatever its Project. */
  listInFlight(): Promise<TicketSummary[]>;
  activeOn(project: string): Promise<TicketSummary | undefined>;
  nextReceived(project: string): Promise<TicketSummary | undefined>;
  listDeclaredWorkspaces(): Promise<DeclaredWorkspace[]>;
};

function cloneIntention(ticket: TicketAdmission): TicketIntention {
  const intention: TicketIntention = {
    key: ticket.key,
    project: ticket.project,
    fingerprint: ticket.fingerprint,
    priority: ticket.priority,
    intention: ticket.intention,
  };
  if (ticket.title !== undefined) {
    intention.title = ticket.title;
  }
  if (ticket.manager !== undefined) {
    intention.manager = ticket.manager;
  }
  if (ticket.external_id !== undefined) {
    intention.external_id = ticket.external_id;
  }
  if (ticket.source !== undefined) {
    intention.source = { ...ticket.source };
  }
  if (ticket.feature !== undefined) {
    intention.feature = ticket.feature;
  }
  if (ticket.blocked_by !== undefined) {
    intention.blocked_by = [...ticket.blocked_by];
  }
  if (ticket.line !== undefined) {
    intention.line = ticket.line;
  }
  return intention;
}

/** The Tickets among what the Port lists: a Feature shares the Port, not the queries. */
function ticketsOf(summaries: Summary[]): TicketSummary[] {
  return summaries.filter((summary): summary is TicketSummary => !isFeatureSummary(summary));
}

/** Received Tickets of a Project in the order they would start: priority, then age. */
function receivedOf(summaries: TicketSummary[], project: string): TicketSummary[] {
  const candidates = summaries.filter((s) => s.project === project && s.state === "received");
  candidates.sort((a, b) => {
    if (b.priority !== a.priority) {
      return b.priority - a.priority;
    }
    return a.received_at - b.received_at;
  });
  return candidates;
}

function projectIsBusy(summaries: TicketSummary[], project: string): boolean {
  return summaries.some((s) => s.project === project && ACTIVE_STATES.has(s.state));
}

/**
 * A held unit starts over from zero: its directory is forgotten, the Attempt
 * it was in is spent, and the lease is gone. Returns whether one was held.
 */
/**
 * The held unit stops. Its workspace stays declared: it is a directory the ledger knows nothing
 * of, and what it holds is the next run's to look at. Whoever wants it gone says so (`clearWorkspace`).
 * `spend`: an unit that ended without recording its Attempts spent one.
 */
function releaseRunningUnit(aggregate: TicketAggregate, spend: boolean): boolean {
  if (aggregate.state !== "running" || aggregate.bail === undefined) {
    return false;
  }
  if (spend) {
    aggregate.attempts_used += 1;
  }
  delete aggregate.bail;
  return true;
}

export function openWorkLedger(options: OpenWorkLedgerOptions): WorkLedger {
  const persist = options.persist;
  const now = options.now ?? (() => Date.now());
  const bailDurationMs = options.bailDurationMs ?? DEFAULT_BAIL_DURATION_MS;

  const loadTicket = async (key: string): Promise<TicketAggregate | undefined> => {
    const found: Aggregate | undefined = await persist.load(key);
    return found === undefined || isFeatureAggregate(found) ? undefined : found;
  };

  /** Whether every Ticket this one waits on is `done`. A blocker nobody knows blocks. */
  const isUnblocked = async (aggregate: TicketAggregate): Promise<boolean> => {
    for (const blocker of aggregate.intention.blocked_by ?? []) {
      const found = await loadTicket(blocker);
      if (found?.state !== "done") {
        return false;
      }
    }
    return true;
  };

  /** The first received Ticket of the Project that may start. */
  const pickReceived = async (
    summaries: TicketSummary[],
    project: string,
  ): Promise<TicketAggregate | undefined> => {
    for (const candidate of receivedOf(summaries, project)) {
      const loaded = await loadTicket(candidate.key);
      if (loaded !== undefined && loaded.state === "received" && (await isUnblocked(loaded))) {
        return loaded;
      }
    }
    return undefined;
  };

  const write = async (aggregate: TicketAggregate): Promise<CommandResult> => {
    const saved = await persist.save(aggregate.intention.key, aggregate);
    if (!saved.ok) {
      return refused("persist-failed");
    }
    return { ok: true };
  };

  const loadOrRefuse = async (
    key: string,
  ): Promise<{ ok: true; aggregate: TicketAggregate } | CommandRefused> => {
    const found = await loadTicket(key);
    if (found === undefined) {
      return refused("not-found");
    }
    return { ok: true, aggregate: structuredClone(found) };
  };

  return {
    async admit(ticket: TicketAdmission): Promise<CommandResult> {
      const existing = await loadTicket(ticket.key);
      if (existing === undefined) {
        const aggregate: TicketAggregate = {
          intention: cloneIntention(ticket),
          state: "received",
          received_at: now(),
          attempts: [],
          attempts_used: 0,
          resumes: 0,
        };
        return await write(aggregate);
      }
      if (existing.state === "merging" || existing.state === "done") {
        return refused("too-late");
      }
      if (existing.state === "cancelled") {
        return refused("illegal-transition");
      }
      if (IN_FLIGHT.has(existing.state)) {
        if (
          ticket.fingerprint === existing.intention.fingerprint ||
          ticket.fingerprint === existing.pending_fingerprint
        ) {
          // Same body as the live intention, or as an edit already recorded:
          // an echo of a report, not a newer TicketStandard.
          return { ok: true };
        }
        const next = structuredClone(existing);
        next.pending_fingerprint = ticket.fingerprint;
        return await write(next);
      }
      if (existing.state === "received" && existing.intention.fingerprint === ticket.fingerprint) {
        return { ok: true };
      }
      if (
        existing.state === "received" ||
        existing.state === "invalid" ||
        existing.state === "escalated"
      ) {
        const next = structuredClone(existing);
        next.intention = cloneIntention(ticket);
        next.state = "received";
        delete next.invalid;
        delete next.pending_fingerprint;
        return await write(next);
      }
      return refused("illegal-transition");
    },

    async recordInvalid(input): Promise<CommandResult> {
      const existing = await loadTicket(input.key);
      if (existing !== undefined && (existing.state === "merging" || existing.state === "done")) {
        return refused("too-late");
      }
      if (existing === undefined) {
        const aggregate: TicketAggregate = {
          intention: {
            key: input.key,
            project: input.project,
            fingerprint: input.fingerprint ?? "",
            priority: input.priority ?? 0,
            intention: "",
          },
          state: "invalid",
          received_at: now(),
          attempts: [],
          attempts_used: 0,
          resumes: 0,
          invalid: { code: input.code, reason: input.reason },
        };
        return await write(aggregate);
      }
      const next = structuredClone(existing);
      next.state = "invalid";
      next.invalid = { code: input.code, reason: input.reason };
      if (input.fingerprint !== undefined) {
        next.intention.fingerprint = input.fingerprint;
      }
      if (input.priority !== undefined) {
        next.intention.priority = input.priority;
      }
      next.intention.project = input.project;
      delete next.bail;
      return await write(next);
    },

    async claim(project: string): Promise<ClaimResult> {
      const summaries = ticketsOf(await persist.listSummaries());
      if (projectIsBusy(summaries, project)) {
        return refused("project-busy");
      }
      const picked = await pickReceived(summaries, project);
      if (picked === undefined) {
        return { ok: true, empty: true };
      }
      const next = structuredClone(picked);
      next.state = "running";
      const saved = await write(next);
      if (!saved.ok) {
        return saved;
      }
      return { ok: true, key: picked.intention.key };
    },

    async recordAttempt(input): Promise<CommandResult> {
      const current = await loadOrRefuse(input.key);
      if (!current.ok) {
        return current;
      }
      const { aggregate } = current;
      if (aggregate.state !== "running") {
        return refused("illegal-transition");
      }
      if (input.number !== aggregate.attempts.length + 1) {
        return refused("illegal-transition");
      }
      const attempt: AttemptRecord = {
        number: input.number,
        round: aggregate.resumes,
      };
      if (input.trace !== undefined) {
        attempt.trace = input.trace;
      }
      aggregate.attempts.push(attempt);
      aggregate.attempts_used += 1;
      return await write(aggregate);
    },

    async startUnit(key: string): Promise<CommandResult> {
      const current = await loadOrRefuse(key);
      if (!current.ok) {
        return current;
      }
      const { aggregate } = current;
      if (aggregate.state !== "running") {
        return refused("illegal-transition");
      }
      if (aggregate.bail !== undefined) {
        return refused("another-running");
      }
      aggregate.bail = { expires_at: now() + bailDurationMs };
      return await write(aggregate);
    },

    async markIntegrating(key: string): Promise<CommandResult> {
      const current = await loadOrRefuse(key);
      if (!current.ok) {
        return current;
      }
      const { aggregate } = current;
      if (aggregate.state !== "running") {
        return refused("illegal-transition");
      }
      aggregate.state = "integrating";
      aggregate.bail = { expires_at: now() + bailDurationMs };
      return await write(aggregate);
    },

    /**
     * The assembled ticket is now in front of the Authority.
     *
     * A second call on an already submitted ticket keeps the first reference:
     * the work was pushed again to the same place, and the Authority is judging
     * the same Submission.
     */
    async markSubmitted(input): Promise<CommandResult> {
      const current = await loadOrRefuse(input.key);
      if (!current.ok) {
        return current;
      }
      const { aggregate } = current;
      if (aggregate.state !== "integrating" && aggregate.state !== "submitted") {
        return refused("illegal-transition");
      }
      aggregate.state = "submitted";
      // Rebuilt field by field, so anything added here has to be carried on
      // purpose. What was already sent back is carried: a Submission offered
      // again is the same Submission, and dropping the reason leaves whoever
      // reads the next escalation with a frozen Ticket and no cause.
      const previous = aggregate.submission;
      aggregate.submission = {
        reference: previous?.reference ?? input.reference,
        submitted_at: previous?.submitted_at ?? now(),
        refusals: previous?.refusals ?? 0,
        ...(previous?.last_report === undefined ? {} : { last_report: previous.last_report }),
        ...(previous?.last_refused_by === undefined
          ? {}
          : { last_refused_by: previous.last_refused_by }),
      };
      aggregate.bail = { expires_at: now() + bailDurationMs };
      return await write(aggregate);
    },

    /**
     * The Authority sent the work back. The report is kept for the next Attempt
     * and the ticket returns to integrating, which is where the work is made.
     */
    async recordRefusal(input): Promise<CommandResult> {
      const current = await loadOrRefuse(input.key);
      if (!current.ok) {
        return current;
      }
      const { aggregate } = current;
      if (aggregate.state !== "submitted" || aggregate.submission === undefined) {
        return refused("illegal-transition");
      }
      aggregate.submission = {
        ...aggregate.submission,
        refusals: aggregate.submission.refusals + 1,
        last_report: input.report,
        ...(input.refusedBy === undefined ? {} : { last_refused_by: input.refusedBy }),
      };
      aggregate.state = "integrating";
      // A parked refusal from an earlier, Authority-less round is stale the
      // moment a Submission has its own: two reports would leave the next fix
      // guessing which one to read.
      delete aggregate.parked_refusal;
      aggregate.bail = { expires_at: now() + bailDurationMs };
      return await write(aggregate);
    },

    /**
     * `assembly.validate` sent the work back, before any Submission exists to
     * hold the reason. Shares the `maxRefusals` budget with `recordRefusal`.
     */
    async recordParkedRefusal(input): Promise<CommandResult> {
      const current = await loadOrRefuse(input.key);
      if (!current.ok) {
        return current;
      }
      const { aggregate } = current;
      if (aggregate.state !== "integrating") {
        return refused("illegal-transition");
      }
      aggregate.parked_refusal = {
        report: input.report,
        ...(input.refusedBy === undefined ? {} : { refused_by: input.refusedBy }),
      };
      aggregate.parked_refusals = (aggregate.parked_refusals ?? 0) + 1;
      return await write(aggregate);
    },

    /** `assembly.validate` accepted the ticket. The counter is the budget spent; it stays. */
    async clearParkedRefusal(key: string): Promise<CommandResult> {
      const current = await loadOrRefuse(key);
      if (!current.ok) {
        return current;
      }
      const { aggregate } = current;
      if (aggregate.parked_refusal === undefined) {
        return { ok: true };
      }
      delete aggregate.parked_refusal;
      return await write(aggregate);
    },

    async markMerging(key: string): Promise<CommandResult> {
      const current = await loadOrRefuse(key);
      if (!current.ok) {
        return current;
      }
      const { aggregate } = current;
      if (aggregate.state !== "integrating" && aggregate.state !== "submitted") {
        return refused("illegal-transition");
      }
      aggregate.state = "merging";
      aggregate.bail = { expires_at: now() + bailDurationMs };
      return await write(aggregate);
    },

    async markDone(
      key: string,
      input?: { reference?: string | undefined },
    ): Promise<CommandResult> {
      const current = await loadOrRefuse(key);
      if (!current.ok) {
        return current;
      }
      const { aggregate } = current;
      if (aggregate.state !== "merging") {
        return refused("illegal-transition");
      }
      aggregate.state = "done";
      if (input?.reference !== undefined) {
        aggregate.integration_reference = input.reference;
      }
      delete aggregate.bail;
      return await write(aggregate);
    },

    async escalate(input): Promise<CommandResult> {
      const current = await loadOrRefuse(input.key);
      if (!current.ok) {
        return current;
      }
      const { aggregate } = current;
      if (aggregate.state === "done" || aggregate.state === "cancelled") {
        return refused("illegal-transition");
      }
      if (input.kind === "unit") {
        const last = aggregate.attempts[aggregate.attempts.length - 1];
        if (last !== undefined && last.trace === undefined) {
          return refused("missing-trace");
        }
      }
      const bornInMerging = aggregate.state === "merging" || input.kind === "merging";
      aggregate.state = "escalated";
      const escalation: TicketAggregate["escalation"] = {
        kind: input.kind,
        born_in_merging: bornInMerging,
      };
      if (input.report !== undefined && input.report.trim().length > 0) {
        escalation.report = input.report;
      }
      aggregate.escalation = escalation;
      // Freezing for a human consumes the in-flight update signal. Resume
      // continues the stored intention; a newer TicketStandard lands by admit.
      delete aggregate.pending_fingerprint;
      delete aggregate.bail;
      return await write(aggregate);
    },

    async resumeTicket(key: string): Promise<CommandResult> {
      const current = await loadOrRefuse(key);
      if (!current.ok) {
        return current;
      }
      const { aggregate } = current;
      if (aggregate.state === "invalid") {
        return refused("illegal-transition");
      }
      if (aggregate.state !== "escalated" || aggregate.escalation === undefined) {
        return refused("illegal-transition");
      }
      const { kind } = aggregate.escalation;
      aggregate.resumes += 1;
      delete aggregate.escalation;
      aggregate.state = kind === "unit" ? "running" : "integrating";
      if (aggregate.state === "integrating") {
        aggregate.bail = { expires_at: now() + bailDurationMs };
      } else {
        // A human's resume of a unit starts it from zero: what it left is not picked up.
        delete aggregate.workspace;
        delete aggregate.first_stage_done;
      }
      return await write(aggregate);
    },

    async cancel(key: string): Promise<CommandResult> {
      const current = await loadOrRefuse(key);
      if (!current.ok) {
        return current;
      }
      const { aggregate } = current;
      if (aggregate.state === "merging" || aggregate.state === "done") {
        return refused("point-of-no-return");
      }
      if (aggregate.escalation?.born_in_merging === true) {
        return refused("point-of-no-return");
      }
      if (aggregate.state === "cancelled") {
        return { ok: true };
      }
      aggregate.state = "cancelled";
      delete aggregate.bail;
      return await write(aggregate);
    },

    async declareWorkspace(input): Promise<CommandResult> {
      const current = await loadOrRefuse(input.key);
      if (!current.ok) {
        return current;
      }
      const { aggregate } = current;
      if (aggregate.state === "done" || aggregate.state === "cancelled") {
        return refused("illegal-transition");
      }
      aggregate.workspace = input.path;
      // Declared anew: nothing is done in it yet.
      delete aggregate.first_stage_done;
      return await write(aggregate);
    },

    async clearWorkspace(key: string): Promise<CommandResult> {
      const current = await loadOrRefuse(key);
      if (!current.ok) {
        return current;
      }
      const { aggregate } = current;
      if (aggregate.workspace === undefined) {
        return { ok: true };
      }
      delete aggregate.workspace;
      delete aggregate.first_stage_done;
      return await write(aggregate);
    },

    async markFirstStageDone(key: string): Promise<CommandResult> {
      const current = await loadOrRefuse(key);
      if (!current.ok) {
        return current;
      }
      const { aggregate } = current;
      if (aggregate.state !== "running" || aggregate.workspace === undefined) {
        return refused("illegal-transition");
      }
      aggregate.first_stage_done = true;
      return await write(aggregate);
    },

    async expireBail(key: string): Promise<CommandResult> {
      const current = await loadOrRefuse(key);
      if (!current.ok) {
        return current;
      }
      const { aggregate } = current;
      if (aggregate.bail === undefined || now() < aggregate.bail.expires_at) {
        return refused("illegal-transition");
      }
      if (!releaseRunningUnit(aggregate, true)) {
        delete aggregate.bail;
      }
      return await write(aggregate);
    },

    async releaseBail(key: string): Promise<CommandResult> {
      const current = await loadOrRefuse(key);
      if (!current.ok) {
        return current;
      }
      const { aggregate } = current;
      if (aggregate.state !== "running") {
        return refused("illegal-transition");
      }
      if (!releaseRunningUnit(aggregate, false)) {
        // Already free: no unit held, nothing to write.
        return { ok: true };
      }
      return await write(aggregate);
    },

    async renewBail(key: string): Promise<CommandResult> {
      const current = await loadOrRefuse(key);
      if (!current.ok) {
        return current;
      }
      const { aggregate } = current;
      if (aggregate.bail === undefined) {
        return refused("illegal-transition");
      }
      aggregate.bail = { expires_at: now() + bailDurationMs };
      return await write(aggregate);
    },

    async get(key: string): Promise<GetResult> {
      const found = await loadTicket(key);
      if (found === undefined) {
        return { ok: false, code: "not-found" };
      }
      return { ok: true, aggregate: found };
    },

    async list(): Promise<TicketSummary[]> {
      return ticketsOf(await persist.listSummaries());
    },

    async listInFlight(): Promise<TicketSummary[]> {
      const summaries = ticketsOf(await persist.listSummaries());
      return summaries.filter((summary) => IN_FLIGHT.has(summary.state));
    },

    async activeOn(project: string): Promise<TicketSummary | undefined> {
      const summaries = ticketsOf(await persist.listSummaries());
      return summaries.find((s) => s.project === project && ACTIVE_STATES.has(s.state));
    },

    async nextReceived(project: string): Promise<TicketSummary | undefined> {
      const summaries = ticketsOf(await persist.listSummaries());
      if (projectIsBusy(summaries, project)) {
        return undefined;
      }
      const picked = await pickReceived(summaries, project);
      return picked === undefined
        ? undefined
        : summaries.find((summary) => summary.key === picked.intention.key);
    },

    async listDeclaredWorkspaces(): Promise<DeclaredWorkspace[]> {
      const summaries = ticketsOf(await persist.listSummaries());
      const listed: DeclaredWorkspace[] = [];
      for (const summary of summaries) {
        const aggregate = await loadTicket(summary.key);
        if (aggregate?.workspace !== undefined) {
          listed.push({ key: summary.key, path: aggregate.workspace });
        }
      }
      return listed;
    },

    ...openFeatureCommands({ persist, now }),
  };
}
