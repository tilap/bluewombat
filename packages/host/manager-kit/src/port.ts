/**
 * What Host asks of the two trackers, whatever the tools behind them.
 *
 * A FeatureTracker holds Features, the needs; a TicketTracker holds the Tickets
 * that build them, and the lines they land on. Nothing here names GitHub, an
 * issue, or a label: a manager package owns its tracker's vocabulary and hands
 * Host these shapes only.
 */

/**
 * Every semantic Event, as values. A manager that mirrors states onto the
 * tracker needs the list at runtime, not only as a type.
 */
export const EVENT_NAMES = [
  "invalid",
  "accepted",
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
  stage?: "unit" | "integrating" | "submitting" | "merging";
  trace?: string;
  counters?: Record<string, string>;
  priority?: number;
  remaining?: number;
  state?: string;
  resume_point?: "running" | "integrating";
  reference?: string;
  /** On `done`: the work line's own name for the fold, when the Authority gave one. Opaque. */
  integration_reference?: string;
  workspace_ref?: string;
};

/** A Feature, normalized: what the FeatureTracker's Adapter hands Host. */
export type FeatureStandard = {
  key: string;
  manager: string;
  external_id: string;
  intent: "upsert" | "resume" | "cancel";
  project: string;
  title?: string;
  intention?: string;
  priority: number;
  /** Keys of the Features that must be `done` before this one may open. */
  blocked_by: string[];
  /** Its line may be folded without a human. */
  merge_when_ready: boolean;
  source?: { ref?: string; revision?: string };
  fingerprint: string;
  normalized_at: string;
};

/** A Ticket, normalized: what the TicketTracker hands Host for a Feature. */
export type TicketStandard = {
  key: string;
  manager: string;
  external_id: string;
  project: string;
  title?: string;
  intention: string;
  priority: number;
  /** Keys of the Tickets that must be `done` before this one may start. */
  blocked_by: string[];
  source?: { ref?: string; revision?: string };
  fingerprint: string;
  normalized_at: string;
};

/** A Ticket and what its tracker says of it beside the words. */
export type TicketEntry = {
  ticket: TicketStandard;
  /** Its specification is final. */
  task_ready: boolean;
  /** A human unblocked it after an escalation. */
  resume: boolean;
  /** False once it is closed on the tracker. */
  open: boolean;
};

/** A Feature as the TicketTracker is asked about it. */
export type FeatureRef = {
  key: string;
  external_id: string;
  project: string;
  source?: { ref?: string; revision?: string };
};

export type TicketsResult =
  | { outcome: "listed"; tickets: TicketEntry[] }
  | { outcome: "unavailable" }
  | { outcome: "interrupted" };

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
   * A Ticket is driven again on every pass while it waits, and an Event that
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
 * A Submission: an assembled Ticket, or a Feature's line, placed where an
 * Authority can judge it.
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

export type LineResult =
  | { outcome: "opened" }
  | { outcome: "refused"; reason: string }
  | { outcome: "unavailable" };

/**
 * Where a Submission stands with the Authority. `folded` is a human's merge as
 * much as the system's; `closed` is the Authority turning it down for good.
 */
export type SettledResult = "open" | "folded" | "closed" | "unavailable";

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

/**
 * The FeatureTracker: where Features are written, ordered and signalled.
 *
 * It is the human surface for a need. It does not list Tickets and it does not
 * hold a line.
 */
export type FeatureTrackerPort = {
  listen(input: { since?: string }): Promise<ListenResult>;
  adapt(payload: Record<string, unknown>): Promise<AdaptResult>;
  report(input: ReportInput): Promise<boolean>;
  /**
   * Whether this raw payload says a human unblocked an escalated Feature.
   * A poll snapshot carries no `resume` edge, so the manager reads its own
   * signal (a label, a status, a field) and Host stays tracker-agnostic.
   */
  signalsResume?(payload: Record<string, unknown>): boolean;
  /**
   * Take the resume signal back once it has been acted on.
   *
   * The signal is an instruction, not a state. Left where a human put it, it
   * resumes the Feature again on every pass, and an escalation that is supposed
   * to freeze the work freezes nothing.
   */
  clearResume?(key: string): Promise<void>;
  /**
   * Whether the Feature this key named is still on the tracker.
   *
   * Optional: a manager that cannot answer (a directory of files, a tracker
   * without a fetch-by-id) omits it, and Host does not invent an absence.
   * Host only asks after a listen that reached the source, so a dead token
   * is not read as a mass abandon.
   */
  probe?(key: string): Promise<ProbeResult>;
};

/**
 * The TicketTracker: where the work that builds a Feature is written, ordered
 * and signalled — and, when it declares them, the Authority that holds the
 * lines.
 */
export type TicketTrackerPort = {
  /** Every Ticket of a Feature, with the signals the tracker carries. */
  tickets(feature: FeatureRef): Promise<TicketsResult>;
  report(input: ReportInput): Promise<boolean>;
  /** Take a Ticket's resume signal back once it has been acted on. */
  clearResume?(key: string): Promise<void>;
  /** Whether the Ticket this key named is still on the tracker. */
  probe?(key: string): Promise<ProbeResult>;
  /**
   * Cut a line from another one: the branch a Feature's Tickets land on.
   * Asking again for a line that exists is a success.
   *
   * The Authority methods come together: a manager that declares none has no
   * Authority, and the work is folded into WorkLineStable directly. Whether a
   * Submission is good is not asked here — that is a Gate's answer.
   */
  openLine?(input: { line: string; from: string }): Promise<LineResult>;
  /** Drop a line nobody will fold. */
  dropLine?(line: string): Promise<void>;
  /** Offer an assembled Ticket, or a Feature's line, to the Authority. */
  submit?(input: SubmissionRequest): Promise<SubmissionResult>;
  /** Have the Authority fold a Submission the Gates accepted into the line it was offered to. */
  fold?(input: { reference: string }): Promise<FoldResult>;
  /** Where a Submission stands, for the ones a human folds. */
  settled?(input: { reference: string }): Promise<SettledResult>;
};
