/** Persisted shapes. Data only — no transitions. */

export type TicketState =
  | "received"
  | "invalid"
  | "running"
  | "escalated"
  | "integrating"
  | "submitted"
  | "merging"
  | "done"
  | "cancelled";

/**
 * Where a Ticket stopped, in terms a person reading the tracker can act on.
 *
 * `unit` is the work being made; `assembly` is the work once assembled, which
 * fails for its own reasons. Reporting one as the other sends a reader to look
 * at work that did not fail.
 */
export type EscalationKind = "unit" | "assembly" | "submitted" | "merging";

export type RefusalCode =
  | "not-found"
  | "duplicate"
  | "illegal-transition"
  | "another-running"
  | "project-busy"
  | "missing-trace"
  | "point-of-no-return"
  | "too-late"
  | "persist-failed";

export type TicketIntention = {
  key: string;
  project: string;
  fingerprint: string;
  priority: number;
  intention: string;
  title?: string;
  manager?: string;
  external_id?: string;
  source?: { ref?: string; revision?: string };
  /** The Feature this Ticket belongs to. */
  feature?: string;
  /** Tickets that must be `done` before this one may start. */
  blocked_by?: string[];
  /** The line this Ticket lands on, when it is not the Project's final one. */
  line?: string;
};

export type TraceRecord = {
  ended: string;
  /** Why the Attempt ended, when it did not end well. */
  report?: string;
  /** Which check produced `report`, when one did. */
  refusedBy?: string;
};

export type AttemptRecord = {
  number: number;
  /**
   * The round this Attempt belongs to: the Ticket's `resumes` when it was
   * recorded. The budget is per round, so a report counting Attempts against
   * it reads this round's alone.
   */
  round: number;
  trace?: TraceRecord;
};

export type BailRecord = {
  expires_at: number;
};

export type EscalationRecord = {
  kind: EscalationKind;
  born_in_merging: boolean;
  /**
   * Why it stopped, in the words of whatever refused it.
   *
   * An escalation is read by a person who was not there. Without this they are
   * told a Ticket is frozen and nothing else, and the reason has to be found
   * again from the outside.
   */
  report?: string;
};

/**
 * What the Authority was given, and what it has sent back so far.
 *
 * `reference` is opaque: the Authority named it, and nothing here reads it.
 * `refusals` counts the times it sent the work back, which is the budget.
 */
export type SubmissionRecord = {
  reference: string;
  submitted_at: number;
  refusals: number;
  last_report?: string;
  /** What refused it, when the refusal came with a name. */
  last_refused_by?: string;
  /**
   * How many times the line moved on while this Submission waited, and the work
   * was sent back to be brought up to date with it. Not a refusal: nothing was
   * wrong with the work. Shares the `maxRefusals` budget as a ceiling of its own.
   */
  realigns?: number;
};

export type InvalidRecord = {
  code: string;
  reason: string;
};

/**
 * A refusal `assembly.validate` sent back, kept on the aggregate because there
 * may be no Submission yet to hold it.
 *
 * `refused_by` is opaque, like `SubmissionRecord.last_refused_by`: whatever
 * named itself in the report.
 */
export type ParkedRefusalRecord = {
  report: string;
  refused_by?: string;
};

export type TicketAggregate = {
  intention: TicketIntention;
  state: TicketState;
  received_at: number;
  attempts: AttemptRecord[];
  attempts_used: number;
  /**
   * How many times a human's resume was taken. A round is what tells two
   * escalations of the same kind apart — refused, resumed, refused again has
   * the same Attempt count both times — so a report can name one.
   */
  resumes: number;
  invalid?: InvalidRecord;
  pending_fingerprint?: string;
  bail?: BailRecord;
  /** The isolated directory the work is made in, once Isolation made one. */
  workspace?: string;
  /**
   * The stage made before the unit's producer ran (the tests, when they are written first)
   * is complete in `workspace`, so a unit picked up again there does not make it again.
   * Gone with the workspace.
   */
  first_stage_done?: boolean;
  escalation?: EscalationRecord;
  submission?: SubmissionRecord;
  /** The work line's own name for the fold that made it `done`, when the Authority gave one. Opaque. */
  integration_reference?: string;
  /**
   * A refusal `assembly.validate` sent back this round, before any Submission
   * exists (or with no Authority at all). Present only while `integrating`.
   * Cleared once validate accepts.
   */
  parked_refusal?: ParkedRefusalRecord;
  /**
   * How many times the work was sent back by `assembly.validate` while no
   * Submission held a count of its own. Shares the `maxRefusals` budget with
   * `submission.refusals` — the comparison that spends it reads both.
   */
  parked_refusals?: number;
};

export type TicketSummary = {
  key: string;
  project: string;
  state: TicketState;
  priority: number;
  received_at: number;
  bail_expires_at?: number;
  feature?: string;
};

/**
 * Where a Feature stands. A Feature waits until it may open, is `open` while
 * its Tickets are made, is `submitted` when its line is with the Authority, and
 * is `done` once the line is folded.
 */
export type FeatureState = "waiting" | "open" | "submitted" | "escalated" | "done" | "cancelled";

export type FeatureIntention = {
  key: string;
  project: string;
  fingerprint: string;
  priority: number;
  intention: string;
  title?: string;
  manager?: string;
  external_id?: string;
  source?: { ref?: string; revision?: string };
  /** Features that must be `done` before this one may open. */
  blocked_by: string[];
  /** The line may be folded without a human. */
  merge_when_ready: boolean;
};

export type FeatureSubmissionRecord = {
  reference: string;
  submitted_at: number;
  /** Times the Authority's judgement sent the line back. */
  refusals?: number;
  /** Times the line it is offered to moved on under the Submission. */
  realigns?: number;
  /** Why it was last sent back; kept until a realign says nothing was wrong. */
  last_report?: string;
  last_refused_by?: string;
};

export type FeatureAggregate = {
  kind: "feature";
  intention: FeatureIntention;
  state: FeatureState;
  received_at: number;
  /** The line the Feature's Tickets land on, once it is open. */
  line?: string;
  /** Keys of the Tickets admitted when the Feature opened. */
  tickets: string[];
  submission?: FeatureSubmissionRecord;
  /** A check refused the line before it was offered: why, for the fix. Cleared once the line is checked again. */
  parked_refusal?: { report: string; refused_by?: string };
  /** Corrective rounds the parked refusals used. Kept when one is cleared: it is budget spent. */
  parked_refusals?: number;
  /** Why it stopped, in the words of whatever refused it. */
  escalation?: { report?: string };
  /** How many times a human's resume was taken. */
  resumes: number;
  pending_fingerprint?: string;
  /** The work line's own name for the fold, when the Authority gave one. Opaque. */
  integration_reference?: string;
};

export type FeatureSummary = {
  kind: "feature";
  key: string;
  project: string;
  state: FeatureState;
  priority: number;
  received_at: number;
};

/** What the Persistence Port stores: one record per key. */
export type Aggregate = TicketAggregate | FeatureAggregate;

export type Summary = TicketSummary | FeatureSummary;

export function isFeatureAggregate(aggregate: Aggregate): aggregate is FeatureAggregate {
  return "kind" in aggregate && aggregate.kind === "feature";
}

export function isFeatureSummary(summary: Summary): summary is FeatureSummary {
  return "kind" in summary && summary.kind === "feature";
}
