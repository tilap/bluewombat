/** Domain types owned by FeatureAdapter. Names match the Block perimeter only. */

export type RunOutcome =
  | "converted"
  | "invalid"
  | "invalid-invocation"
  | "unavailable"
  | "interrupted";

export type Intent = "upsert" | "ready" | "cancel";

export type InvalidCode =
  | "raw-too-large"
  | "raw-not-json"
  | "raw-not-object"
  | "not-an-issue"
  | "unknown-action"
  | "missing-id"
  | "missing-project"
  | "ambiguous-project"
  | "missing-intention"
  | "bad-field-type"
  | "bad-priority";

export type Repository = { owner: string; name: string };

export type Invocation = {
  manager: string;
  repo: Repository;
  /** Root of the REST API, so a GitHub Enterprise host is one argument away. */
  apiBase: string;
  /** The raw intention as one argument; absent means stdin. */
  raw?: string;
  defaultProject?: string;
  defaultPriority: number;
  maxRawBytes: number;
  /** Prefix of the label carrying the project, e.g. `project:`. */
  projectLabelPrefix: string;
  /** Prefix of the label carrying the priority, e.g. `priority:`. */
  priorityLabelPrefix: string;
  /** Label whose arrival means a human unblocked the intention. */
  readyLabel: string;
  /** Re-read the issue from the API before normalizing. */
  fetch: boolean;
  fetchDurationMs?: number;
  requestRetries: number;
  /** Value stamped as normalized_at; absent means the current time. */
  at?: string;
};

export type ParseResult =
  /** The token is beside the Invocation, never inside it, and only a Fetch needs one. */
  { ok: true; invocation: Invocation; token?: string } | { ok: false; reason: string };

export type FeatureStandard = {
  key: string;
  manager: string;
  external_id: string;
  intent: Intent;
  project: string;
  title?: string;
  intention?: string;
  priority: number;
  source?: { ref?: string; revision?: string };
  fingerprint: string;
  normalized_at: string;
};

export type Invalid = { code: InvalidCode; reason: string };

export type NormalizeResult =
  | { ok: true; feature: FeatureStandard }
  | { ok: false; invalid: Invalid };
