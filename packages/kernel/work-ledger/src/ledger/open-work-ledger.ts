import type { PersistencePort } from "../persist/port.js";
import type {
  AttemptRecord,
  EscalationKind,
  FeatureAggregate,
  FeatureIntention,
  FeatureState,
  FeatureSummary,
  RefusalCode,
  TraceRecord,
} from "../records.js";
import { checkPlan, initialSubtaskState, type PlanDraft, refreshRunnable } from "./check-plan.js";

const DEFAULT_BAIL_DURATION_MS = 3_600_000;

const ACTIVE_STATES: ReadonlySet<FeatureState> = new Set([
  "planning",
  "running",
  "escalated",
  "integrating",
  "submitted",
  "merging",
]);

const IN_FLIGHT: ReadonlySet<FeatureState> = new Set([
  "planning",
  "running",
  "integrating",
  "submitted",
]);

export type FeatureAdmission = FeatureIntention;

export type CommandOk = { ok: true };
export type CommandRefused = { ok: false; code: RefusalCode };
export type CommandResult = CommandOk | CommandRefused;

export type ClaimResult = { ok: true; key: string } | { ok: true; empty: true } | CommandRefused;

export type GetResult =
  | { ok: true; aggregate: FeatureAggregate }
  | { ok: false; code: "not-found" };

export type OpenWorkLedgerOptions = {
  persist: PersistencePort;
  now?: () => number;
  bailDurationMs?: number;
};

export type EscalateInput = {
  key: string;
  kind: EscalationKind;
  subtaskId?: string;
  /** Why it stopped. Kept so the person who reads the escalation is told. */
  report?: string;
};

export type RecordAttemptInput = {
  key: string;
  subtaskId: string;
  number: number;
  trace?: TraceRecord;
};

export type DeclareWorkspaceInput = {
  key: string;
  feature?: string;
  subtask?: string;
};

export type ClearWorkspaceInput = {
  key: string;
  feature?: boolean;
  subtask?: boolean;
};

export type DeclaredWorkspace = {
  key: string;
  feature?: string;
  subtask?: string;
};

export type WorkLedger = {
  admit(feature: FeatureAdmission): Promise<CommandResult>;
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
  recordPlan(input: {
    key: string;
    plannedAt: string;
    subtasks: PlanDraft[];
  }): Promise<CommandResult>;
  refusePlan(input: { key: string; code: string; reason: string }): Promise<CommandResult>;
  startSubtask(input: { key: string; subtaskId: string }): Promise<CommandResult>;
  recordAttempt(input: RecordAttemptInput): Promise<CommandResult>;
  markSubtaskIntegrated(input: { key: string; subtaskId: string }): Promise<CommandResult>;
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
  resumeReady(key: string): Promise<CommandResult>;
  cancel(key: string): Promise<CommandResult>;
  declareWorkspace(input: DeclareWorkspaceInput): Promise<CommandResult>;
  clearWorkspace(input: ClearWorkspaceInput): Promise<CommandResult>;
  expireBail(key: string): Promise<CommandResult>;
  /**
   * Drop a held Subtask (or planning) without waiting for the bail clock.
   * Same ledger outcome as an expired bail in those states.
   */
  releaseBail(key: string): Promise<CommandResult>;
  renewBail(key: string): Promise<CommandResult>;
  get(key: string): Promise<GetResult>;
  /** Every known Feature, whatever its state. */
  list(): Promise<FeatureSummary[]>;
  /** Every Feature mid-flight, whatever its Project. */
  listInFlight(): Promise<FeatureSummary[]>;
  activeOn(project: string): Promise<FeatureSummary | undefined>;
  nextReceived(project: string): Promise<FeatureSummary | undefined>;
  nextRunnable(key: string): Promise<string | undefined>;
  listDeclaredWorkspaces(): Promise<DeclaredWorkspace[]>;
};

function refused(code: RefusalCode): CommandRefused {
  return { ok: false, code };
}

function cloneIntention(feature: FeatureAdmission): FeatureIntention {
  const intention: FeatureIntention = {
    key: feature.key,
    project: feature.project,
    fingerprint: feature.fingerprint,
    priority: feature.priority,
    intention: feature.intention,
  };
  if (feature.title !== undefined) {
    intention.title = feature.title;
  }
  if (feature.manager !== undefined) {
    intention.manager = feature.manager;
  }
  if (feature.external_id !== undefined) {
    intention.external_id = feature.external_id;
  }
  if (feature.source !== undefined) {
    intention.source = { ...feature.source };
  }
  return intention;
}

function pickReceived(summaries: FeatureSummary[], project: string): FeatureSummary | undefined {
  const candidates = summaries.filter((s) => s.project === project && s.state === "received");
  candidates.sort((a, b) => {
    if (b.priority !== a.priority) {
      return b.priority - a.priority;
    }
    return a.received_at - b.received_at;
  });
  return candidates[0];
}

function projectIsBusy(summaries: FeatureSummary[], project: string): boolean {
  return summaries.some((s) => s.project === project && ACTIVE_STATES.has(s.state));
}

function unblocksCount(
  subtaskId: string,
  subtasks: { id: string; depends_on: string[] }[],
): number {
  return subtasks.filter((st) => st.depends_on.includes(subtaskId)).length;
}

/** Drop a declared Subtask workspace path; keep the feature path when present. */
function clearSubtaskWorkspace(aggregate: FeatureAggregate): void {
  if (aggregate.workspaces === undefined) {
    return;
  }
  delete aggregate.workspaces.subtask;
  if (aggregate.workspaces.feature === undefined) {
    delete aggregate.workspaces;
  }
}

/**
 * A held Subtask becomes runnable from zero. Returns whether one was held.
 */
function releaseRunningSubtask(aggregate: FeatureAggregate): boolean {
  if (aggregate.plan === undefined) {
    return false;
  }
  const running = aggregate.plan.subtasks.find((st) => st.state === "running");
  if (running === undefined) {
    return false;
  }
  running.state = "runnable";
  aggregate.attempts_used += 1;
  clearSubtaskWorkspace(aggregate);
  delete aggregate.bail;
  return true;
}

export function openWorkLedger(options: OpenWorkLedgerOptions): WorkLedger {
  const persist = options.persist;
  const now = options.now ?? (() => Date.now());
  const bailDurationMs = options.bailDurationMs ?? DEFAULT_BAIL_DURATION_MS;

  const write = async (aggregate: FeatureAggregate): Promise<CommandResult> => {
    const saved = await persist.save(aggregate.intention.key, aggregate);
    if (!saved.ok) {
      return refused("persist-failed");
    }
    return { ok: true };
  };

  const loadOrRefuse = async (
    key: string,
  ): Promise<{ ok: true; aggregate: FeatureAggregate } | CommandRefused> => {
    const found = await persist.load(key);
    if (found === undefined) {
      return refused("not-found");
    }
    return { ok: true, aggregate: structuredClone(found) };
  };

  return {
    async admit(feature: FeatureAdmission): Promise<CommandResult> {
      const existing = await persist.load(feature.key);
      if (existing === undefined) {
        const aggregate: FeatureAggregate = {
          intention: cloneIntention(feature),
          state: "received",
          received_at: now(),
          attempts: [],
          attempts_used: 0,
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
          feature.fingerprint === existing.intention.fingerprint ||
          feature.fingerprint === existing.pending_fingerprint
        ) {
          // Same body as the live intention, or as an edit already recorded:
          // an echo of a report, not a newer FeatureStandard.
          return { ok: true };
        }
        const next = structuredClone(existing);
        next.pending_fingerprint = feature.fingerprint;
        return await write(next);
      }
      if (existing.state === "received" && existing.intention.fingerprint === feature.fingerprint) {
        return { ok: true };
      }
      if (
        existing.state === "received" ||
        existing.state === "invalid" ||
        existing.state === "escalated"
      ) {
        const next = structuredClone(existing);
        next.intention = cloneIntention(feature);
        next.state = "received";
        delete next.invalid;
        delete next.pending_fingerprint;
        return await write(next);
      }
      return refused("illegal-transition");
    },

    async recordInvalid(input): Promise<CommandResult> {
      const existing = await persist.load(input.key);
      if (existing !== undefined && (existing.state === "merging" || existing.state === "done")) {
        return refused("too-late");
      }
      if (existing === undefined) {
        const aggregate: FeatureAggregate = {
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
      const summaries = await persist.listSummaries();
      if (projectIsBusy(summaries, project)) {
        return refused("project-busy");
      }
      const picked = pickReceived(summaries, project);
      if (picked === undefined) {
        return { ok: true, empty: true };
      }
      const loaded = await persist.load(picked.key);
      if (loaded === undefined || loaded.state !== "received") {
        return { ok: true, empty: true };
      }
      const next = structuredClone(loaded);
      next.state = "planning";
      next.bail = { expires_at: now() + bailDurationMs };
      const saved = await write(next);
      if (!saved.ok) {
        return saved;
      }
      return { ok: true, key: picked.key };
    },

    async recordPlan(input): Promise<CommandResult> {
      const current = await loadOrRefuse(input.key);
      if (!current.ok) {
        return current;
      }
      const { aggregate } = current;
      if (aggregate.state !== "planning") {
        return refused("illegal-transition");
      }
      if (aggregate.plan !== undefined) {
        return refused("plan-frozen");
      }
      const checked = checkPlan(input.subtasks);
      if (!checked.ok) {
        return refused("illegal-transition");
      }
      aggregate.plan = {
        planned_at: input.plannedAt,
        subtasks: checked.subtasks.map((draft) => ({
          ...draft,
          state: initialSubtaskState(draft),
        })),
      };
      aggregate.state = "running";
      aggregate.bail = { expires_at: now() + bailDurationMs };
      return await write(aggregate);
    },

    async refusePlan(input): Promise<CommandResult> {
      const current = await loadOrRefuse(input.key);
      if (!current.ok) {
        return current;
      }
      const { aggregate } = current;
      if (aggregate.state !== "planning") {
        return refused("illegal-transition");
      }
      aggregate.state = "escalated";
      aggregate.escalation = { kind: "plan", born_in_merging: false };
      aggregate.invalid = { code: input.code, reason: input.reason };
      delete aggregate.bail;
      return await write(aggregate);
    },

    async startSubtask(input): Promise<CommandResult> {
      const current = await loadOrRefuse(input.key);
      if (!current.ok) {
        return current;
      }
      const { aggregate } = current;
      if (aggregate.plan === undefined) {
        return refused("plan-not-frozen");
      }
      if (aggregate.state !== "running") {
        return refused("illegal-transition");
      }
      if (aggregate.plan.subtasks.some((st) => st.state === "running")) {
        return refused("another-running");
      }
      const subtask = aggregate.plan.subtasks.find((st) => st.id === input.subtaskId);
      if (subtask === undefined) {
        return refused("not-found");
      }
      if (subtask.state !== "runnable") {
        return refused("subtask-not-runnable");
      }
      subtask.state = "running";
      aggregate.bail = { expires_at: now() + bailDurationMs };
      return await write(aggregate);
    },

    async recordAttempt(input): Promise<CommandResult> {
      const current = await loadOrRefuse(input.key);
      if (!current.ok) {
        return current;
      }
      const { aggregate } = current;
      if (aggregate.plan === undefined) {
        return refused("plan-not-frozen");
      }
      const subtask = aggregate.plan.subtasks.find((st) => st.id === input.subtaskId);
      if (subtask === undefined || subtask.state !== "running") {
        return refused("illegal-transition");
      }
      const existing = aggregate.attempts.filter((a) => a.subtask_id === input.subtaskId);
      const nextNumber = existing.length + 1;
      if (input.number !== nextNumber) {
        return refused("illegal-transition");
      }
      const attempt: AttemptRecord = {
        subtask_id: input.subtaskId,
        number: input.number,
        round: aggregate.resumes ?? 0,
      };
      if (input.trace !== undefined) {
        attempt.trace = input.trace;
      }
      aggregate.attempts.push(attempt);
      aggregate.attempts_used += 1;
      return await write(aggregate);
    },

    async markSubtaskIntegrated(input): Promise<CommandResult> {
      const current = await loadOrRefuse(input.key);
      if (!current.ok) {
        return current;
      }
      const { aggregate } = current;
      if (aggregate.state !== "running" || aggregate.plan === undefined) {
        return refused("illegal-transition");
      }
      const subtask = aggregate.plan.subtasks.find((st) => st.id === input.subtaskId);
      if (subtask === undefined || subtask.state !== "running") {
        return refused("illegal-transition");
      }
      subtask.state = "integrated";
      aggregate.plan.subtasks = refreshRunnable(aggregate.plan.subtasks);
      const terminal = new Set(["integrated", "cancelled"]);
      const remaining = aggregate.plan.subtasks.some((st) => !terminal.has(st.state));
      if (!remaining) {
        aggregate.state = "integrating";
      }
      aggregate.bail = { expires_at: now() + bailDurationMs };
      return await write(aggregate);
    },

    /**
     * The assembled feature is now in front of the Authority.
     *
     * A second call on an already submitted feature keeps the first reference:
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
      // reads the next escalation with a frozen Feature and no cause.
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
     * and the feature returns to integrating, which is where the work is made.
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

    /** `assembly.validate` accepted the feature. The counter is the budget spent; it stays. */
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
      if (aggregate.workspaces !== undefined) {
        delete aggregate.workspaces.subtask;
        if (aggregate.workspaces.feature === undefined) {
          delete aggregate.workspaces;
        }
      }
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
      if (input.kind === "subtask" && input.subtaskId !== undefined) {
        const attempts = aggregate.attempts.filter((a) => a.subtask_id === input.subtaskId);
        if (attempts.length > 0) {
          const last = attempts[attempts.length - 1];
          if (last?.trace === undefined) {
            return refused("missing-trace");
          }
        }
      }
      const bornInMerging = aggregate.state === "merging" || input.kind === "merging";
      aggregate.state = "escalated";
      const escalation: FeatureAggregate["escalation"] = {
        kind: input.kind,
        born_in_merging: bornInMerging,
      };
      if (input.subtaskId !== undefined) {
        escalation.subtask_id = input.subtaskId;
      }
      if (input.report !== undefined && input.report.trim().length > 0) {
        escalation.report = input.report;
      }
      aggregate.escalation = escalation;
      // Freezing for a human consumes the in-flight update signal. Resume
      // continues the stored intention; a newer FeatureStandard lands by admit.
      delete aggregate.pending_fingerprint;
      if (aggregate.plan !== undefined && input.subtaskId !== undefined) {
        const subtask = aggregate.plan.subtasks.find((st) => st.id === input.subtaskId);
        if (subtask !== undefined && subtask.state === "running") {
          subtask.state = "escalated";
        }
      }
      delete aggregate.bail;
      return await write(aggregate);
    },

    async resumeReady(key: string): Promise<CommandResult> {
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
      const { kind, subtask_id } = aggregate.escalation;
      aggregate.resumes = (aggregate.resumes ?? 0) + 1;
      if (kind === "plan") {
        delete aggregate.plan;
        aggregate.state = "planning";
        delete aggregate.invalid;
        delete aggregate.escalation;
        aggregate.bail = { expires_at: now() + bailDurationMs };
        return await write(aggregate);
      }
      if (kind === "merging" || kind === "submitted" || kind === "assembly") {
        aggregate.state = "integrating";
        delete aggregate.escalation;
        aggregate.bail = { expires_at: now() + bailDurationMs };
        return await write(aggregate);
      }
      if (kind === "subtask" && subtask_id !== undefined && aggregate.plan !== undefined) {
        const subtask = aggregate.plan.subtasks.find((st) => st.id === subtask_id);
        if (subtask !== undefined) {
          subtask.state = "runnable";
        }
        aggregate.state = "running";
        delete aggregate.escalation;
        aggregate.bail = { expires_at: now() + bailDurationMs };
        return await write(aggregate);
      }
      return refused("illegal-transition");
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
      if (aggregate.plan !== undefined) {
        aggregate.plan.subtasks = aggregate.plan.subtasks.map((st) =>
          st.state === "integrated" ? st : { ...st, state: "cancelled" as const },
        );
      }
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
      const workspaces = { ...aggregate.workspaces };
      if (input.feature !== undefined) {
        workspaces.feature = input.feature;
      }
      if (input.subtask !== undefined) {
        workspaces.subtask = input.subtask;
      }
      aggregate.workspaces = workspaces;
      return await write(aggregate);
    },

    async clearWorkspace(input): Promise<CommandResult> {
      const current = await loadOrRefuse(input.key);
      if (!current.ok) {
        return current;
      }
      const { aggregate } = current;
      if (aggregate.workspaces === undefined) {
        return { ok: true };
      }
      if (input.feature === true) {
        delete aggregate.workspaces.feature;
      }
      if (input.subtask === true) {
        delete aggregate.workspaces.subtask;
      }
      if (
        aggregate.workspaces.feature === undefined &&
        aggregate.workspaces.subtask === undefined
      ) {
        delete aggregate.workspaces;
      }
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
      if (aggregate.state === "planning") {
        aggregate.state = "received";
        delete aggregate.bail;
        return await write(aggregate);
      }
      if (aggregate.state === "running" && aggregate.plan !== undefined) {
        if (!releaseRunningSubtask(aggregate)) {
          clearSubtaskWorkspace(aggregate);
          delete aggregate.bail;
        }
        return await write(aggregate);
      }
      delete aggregate.bail;
      return await write(aggregate);
    },

    async releaseBail(key: string): Promise<CommandResult> {
      const current = await loadOrRefuse(key);
      if (!current.ok) {
        return current;
      }
      const { aggregate } = current;
      if (aggregate.state === "planning") {
        aggregate.state = "received";
        delete aggregate.bail;
        return await write(aggregate);
      }
      if (aggregate.state === "running" && aggregate.plan !== undefined) {
        if (!releaseRunningSubtask(aggregate)) {
          // Already free: no Subtask held, nothing to write.
          return { ok: true };
        }
        return await write(aggregate);
      }
      return refused("illegal-transition");
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
      const found = await persist.load(key);
      if (found === undefined) {
        return { ok: false, code: "not-found" };
      }
      return { ok: true, aggregate: found };
    },

    async list(): Promise<FeatureSummary[]> {
      return await persist.listSummaries();
    },

    async listInFlight(): Promise<FeatureSummary[]> {
      const summaries = await persist.listSummaries();
      return summaries.filter((summary) => IN_FLIGHT.has(summary.state));
    },

    async activeOn(project: string): Promise<FeatureSummary | undefined> {
      const summaries = await persist.listSummaries();
      return summaries.find((s) => s.project === project && ACTIVE_STATES.has(s.state));
    },

    async nextReceived(project: string): Promise<FeatureSummary | undefined> {
      const summaries = await persist.listSummaries();
      if (projectIsBusy(summaries, project)) {
        return undefined;
      }
      return pickReceived(summaries, project);
    },

    async nextRunnable(key: string): Promise<string | undefined> {
      const found = await persist.load(key);
      if (found?.plan === undefined) {
        return undefined;
      }
      const runnable = found.plan.subtasks.filter((st) => st.state === "runnable");
      if (runnable.length === 0) {
        return undefined;
      }
      runnable.sort(
        (a, b) =>
          unblocksCount(b.id, found.plan?.subtasks ?? []) -
          unblocksCount(a.id, found.plan?.subtasks ?? []),
      );
      return runnable[0]?.id;
    },

    async listDeclaredWorkspaces(): Promise<DeclaredWorkspace[]> {
      const summaries = await persist.listSummaries();
      const listed: DeclaredWorkspace[] = [];
      for (const summary of summaries) {
        const aggregate = await persist.load(summary.key);
        if (aggregate?.workspaces === undefined) {
          continue;
        }
        const row: DeclaredWorkspace = { key: summary.key };
        if (aggregate.workspaces.feature !== undefined) {
          row.feature = aggregate.workspaces.feature;
        }
        if (aggregate.workspaces.subtask !== undefined) {
          row.subtask = aggregate.workspaces.subtask;
        }
        if (row.feature !== undefined || row.subtask !== undefined) {
          listed.push(row);
        }
      }
      return listed;
    },
  };
}
