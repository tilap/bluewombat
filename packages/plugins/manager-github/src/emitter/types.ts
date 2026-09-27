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

/** The Target: one repository. */
export type Repository = { owner: string; name: string };

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
  repo: Repository;
  /** The Thread: the issue this Event is appended to. */
  issue: number;
  /** Root of the REST API, so a GitHub Enterprise host is one argument away. */
  apiBase: string;
  event: EventName;
  key: string;
  project: string;
  at: string;
  eventId?: string;
  fields: EventFields;
  maxReportChars: number;
  /** What `priority` is when nobody chose one, so the comment can say so. */
  defaultPriority?: number;
  /** When set, the Event also lands as `<prefix><event>` on the issue. */
  labelPrefix?: string;
  /** The label that signals `ready`, so an `escalated` comment can name it. */
  readyLabel?: string;
  durationMs: number;
  /** Extra attempts after the first, on a transport failure, a 5xx, or a rate limit. */
  requestRetries: number;
  dryRun: boolean;
};

export type ParseResult =
  /** The token is beside the Invocation, never inside it; a dry run needs none. */
  { ok: true; invocation: Invocation; token?: string } | { ok: false; reason: string };

/** The record a comment carries for machines, inside its marker. */
export type EventRecord = Record<string, unknown>;
