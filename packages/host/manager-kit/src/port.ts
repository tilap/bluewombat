/**
 * What Host asks of one FeatureManager, whatever the tracker behind it.
 *
 * Nothing here names GitHub, an issue, or a label: a manager package owns its
 * tracker's vocabulary and hands Host these shapes only.
 */

/**
 * Every semantic Event, as values. A manager that mirrors states onto the
 * tracker needs the list at runtime, not only as a type.
 */
export const EVENT_NAMES = [
  "invalid",
  "accepted",
  "planned",
  "progress",
  "escalated",
  "escalation_reminder",
  "resumed",
  "submitted",
  "done",
  "cancelled",
  "reject_late",
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

export type EventFields = {
  /** One sentence a reader gets first, under the heading and before any field. */
  summary?: string;
  reason?: string;
  stage?: "plan" | "unit" | "integrating" | "submitting" | "merging";
  trace?: string;
  counters?: Record<string, string>;
  plan?: string;
  priority?: number;
  unit?: string;
  remaining?: number;
  state?: string;
  resume_point?: "planning" | "running" | "integrating";
  reference?: string;
  /** On `done`: the work line's own name for the fold, when the Authority gave one. Opaque. */
  integration_reference?: string;
  workspace_ref?: string;
};

export type FeatureStandard = {
  key: string;
  manager: string;
  external_id: string;
  intent: "upsert" | "ready" | "cancel";
  project: string;
  title?: string;
  intention?: string;
  priority: number;
  source?: { ref?: string; revision?: string };
  fingerprint: string;
  normalized_at: string;
};

/** One raw intention, plus the Cursor Host saves once it is handled. */
export type Delivery = {
  cursor: string;
  payload: Record<string, unknown>;
};

export type AdaptResult =
  | { outcome: "converted"; feature: FeatureStandard }
  | {
      outcome: "invalid";
      invalid: { code: string; reason: string };
      key: string;
      project: string;
      /**
       * Hash of what a human wrote — not of what the tracker does to the
       * intention afterwards. Reporting an intention invalid writes to the
       * tracker, and that write delivers it again; the same fingerprint says
       * nothing changed, so nothing is said again.
       */
      fingerprint: string;
    }
  | { outcome: "unavailable" }
  | { outcome: "interrupted" };

export type ReportInput = {
  event: EventName;
  key: string;
  project: string;
  fields: EventFields;
  /**
   * Names this Event so it is reported once.
   *
   * A feature is driven again on every pass while it waits, and an Event that
   * only says what already happened must not be said twice. A manager that
   * keeps a thread skips an id it has already written.
   */
  eventId?: string;
};

export type ListenResult = {
  outcome: string;
  deliveries: Delivery[];
};

/**
 * A Submission: an assembled feature placed where an Authority can judge it.
 *
 * `ref` is what the system published and `target` the work line it is offered
 * to — both opaque here. The Authority reads them; this contract does not.
 */
export type SubmissionRequest = {
  key: string;
  project: string;
  ref: string;
  target: string;
  title?: string;
  intention?: string;
  /** The Plan's Subtasks, in order — what the Submission is made of. */
  steps?: string[];
  /**
   * How the delivered work describes itself, when the Project has a say — a
   * subject line and a body. What the Authority makes of them is its own: a
   * fold's message, a pull request's text, a comment. Absent: the title and
   * the intention, as the human wrote them.
   */
  description?: { subject: string; body?: string };
};

export type SubmissionResult =
  | { outcome: "submitted"; reference: string }
  | { outcome: "refused"; reason: string }
  | { outcome: "unavailable" };

export type FoldResult =
  /** `reference`: the work line's own name for the fold, when the Authority can give one. Opaque. */
  | { outcome: "folded"; reference?: string }
  | { outcome: "conflict"; reason: string }
  | { outcome: "unavailable" };

/**
 * Whether the intention this key named is still on the tracker.
 *
 * A poll cannot see an absence: a deleted item simply never appears again.
 * Host asks this of keys it already holds. `gone` is abandon — the same
 * intent as a `cancel` delivery. `unavailable` is not: a missed read must
 * not abandon work.
 */
export type ProbeResult = "present" | "gone" | "unavailable" | "interrupted";

export type ManagerPort = {
  listen(input: { since?: string }): Promise<ListenResult>;
  adapt(payload: Record<string, unknown>): Promise<AdaptResult>;
  report(input: ReportInput): Promise<boolean>;
  /**
   * Whether this raw payload says a human unblocked an escalated Feature.
   * A poll snapshot carries no `ready` edge, so the manager reads its own
   * signal (a label, a status, a field) and Host stays tracker-agnostic.
   */
  signalsReady?(payload: Record<string, unknown>): boolean;
  /**
   * Take the resume signal back once it has been acted on.
   *
   * The signal is an instruction, not a state. Left where a human put it, it
   * resumes the Feature again on every pass, and an escalation that is supposed
   * to freeze the work freezes nothing.
   */
  clearReady?(key: string): Promise<void>;
  /**
   * Offer an assembled feature to the Authority.
   *
   * Both Submission methods come as a pair: a manager that declares neither has
   * no Authority, and the work is folded into WorkLineStable directly, as it was
   * before any of this existed. Whether the Submission is good is not asked
   * here — that is a Gate's answer.
   */
  submit?(input: SubmissionRequest): Promise<SubmissionResult>;
  /** Have the Authority fold a Submission the Gates accepted into the work line. */
  fold?(input: { reference: string }): Promise<FoldResult>;
  /**
   * Whether the intention this key named is still on the tracker.
   *
   * Optional: a manager that cannot answer (a directory of files, a tracker
   * without a fetch-by-id) omits it, and Host does not invent an absence.
   * Host only asks after a listen that reached the source, so a dead token
   * is not read as a mass abandon.
   */
  probe?(key: string): Promise<ProbeResult>;
};
