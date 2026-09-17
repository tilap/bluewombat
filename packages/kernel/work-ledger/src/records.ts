/** Persisted shapes. Data only — no transitions. */

export type FeatureState =
  | "received"
  | "invalid"
  | "planning"
  | "running"
  | "escalated"
  | "integrating"
  | "submitted"
  | "merging"
  | "done"
  | "cancelled";

export type SubtaskState =
  | "pending"
  | "runnable"
  | "running"
  | "escalated"
  | "integrated"
  | "cancelled";

/**
 * Where a Feature stopped, in terms a person reading the tracker can act on.
 *
 * `subtask` is one unit of work; `assembly` is the whole they make up, which
 * fails for its own reasons and names no unit. Reporting one as the other sends
 * a reader to look at work that did not fail.
 */
export type EscalationKind = "plan" | "subtask" | "assembly" | "submitted" | "merging";

export type RefusalCode =
  | "not-found"
  | "duplicate"
  | "illegal-transition"
  | "project-busy"
  | "plan-frozen"
  | "plan-not-frozen"
  | "subtask-not-runnable"
  | "another-running"
  | "missing-trace"
  | "point-of-no-return"
  | "too-late"
  | "persist-failed";

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
};

export type PlannedSubtask = {
  id: string;
  intention: string;
  definition_of_done: string;
  depends_on: string[];
  state: SubtaskState;
};

export type PlanRecord = {
  planned_at: string;
  subtasks: PlannedSubtask[];
};

export type TraceRecord = {
  ended: string;
  /** Why the Attempt ended, when it did not end well. */
  report?: string;
  /** Which check produced `report`, when one did. */
  refusedBy?: string;
};

export type AttemptRecord = {
  subtask_id: string;
  number: number;
  /**
   * The round this Attempt belongs to: the Feature's `resumes` when it was
   * recorded. The budget is per round, so a report counting Attempts against
   * it reads this round's alone. Absent on a record written before: read as 0.
   */
  round?: number;
  trace?: TraceRecord;
};

export type BailRecord = {
  expires_at: number;
};

export type WorkspacesRecord = {
  feature?: string;
  subtask?: string;
};

export type EscalationRecord = {
  kind: EscalationKind;
  born_in_merging: boolean;
  subtask_id?: string;
  /**
   * Why it stopped, in the words of whatever refused it.
   *
   * An escalation is read by a person who was not there. Without this they are
   * told a Feature is frozen and nothing else, and the reason has to be found
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
};

export type InvalidRecord = {
  code: string;
  reason: string;
};

export type FeatureAggregate = {
  intention: FeatureIntention;
  state: FeatureState;
  received_at: number;
  attempts: AttemptRecord[];
  attempts_used: number;
  /**
   * How many times a human's `ready` was taken. A round is what tells two
   * escalations of the same kind apart — a plan refused, resumed, refused
   * again has the same Attempt count both times — so a report can name one.
   * Absent on a record written before the counter existed: read as 0.
   */
  resumes?: number;
  invalid?: InvalidRecord;
  pending_fingerprint?: string;
  plan?: PlanRecord;
  bail?: BailRecord;
  workspaces?: WorkspacesRecord;
  escalation?: EscalationRecord;
  submission?: SubmissionRecord;
  /** The work line's own name for the fold that made it `done`, when the Authority gave one. Opaque. */
  integration_reference?: string;
};

export type FeatureSummary = {
  key: string;
  project: string;
  state: FeatureState;
  priority: number;
  received_at: number;
  bail_expires_at?: number;
};
