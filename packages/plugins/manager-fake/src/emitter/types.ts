/** Domain types owned by FeatureEmitter. Names match the Block perimeter only. */

export type RunOutcome =
  | "reported"
  | "duplicate"
  | "rendered"
  | "unreportable"
  | "invalid-invocation"
  | "interrupted";

export type EventName =
  | "invalid"
  | "accepted"
  | "planned"
  | "progress"
  | "escalated"
  | "escalation_reminder"
  | "resumed"
  | "submitted"
  | "done"
  | "cancelled"
  | "reject_late";

export type Stage = "plan" | "unit" | "integrating" | "submitting" | "merging";

export type ResumePoint = "planning" | "running" | "integrating";

/** Every field an Event may carry beyond key, project and timestamp. */
export type EventFields = {
  /** One sentence a reader gets first, under the heading and before any field. */
  summary?: string;
  reason?: string;
  stage?: Stage;
  trace?: string;
  counters?: Record<string, string>;
  plan?: string;
  priority?: number;
  unit?: string;
  remaining?: number;
  state?: string;
  resume_point?: ResumePoint;
  reference?: string;
  /** On `done`: the work line's own name for the fold — a commit — when the Authority gave one. */
  integration_reference?: string;
  workspace_ref?: string;
};

export type Invocation = {
  target: string;
  event: EventName;
  key: string;
  project: string;
  at: string;
  eventId?: string;
  fields: EventFields;
  maxReportChars: number;
  dryRun: boolean;
};

export type ParseResult = { ok: true; invocation: Invocation } | { ok: false; reason: string };

/** The record appended to the machine surface of a Thread. */
export type EventRecord = Record<string, unknown>;
