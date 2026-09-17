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
  | "unknown-kind"
  | "missing-id"
  | "missing-project"
  | "missing-intention"
  | "bad-field-type"
  | "bad-priority";

export type Invocation = {
  manager: string;
  /** The raw intention as one argument; absent means stdin. */
  raw?: string;
  defaultProject?: string;
  defaultPriority: number;
  maxRawBytes: number;
  fetchArgv?: string[];
  fetchDurationMs?: number;
  /** Value stamped as normalized_at; absent means the current time. */
  at?: string;
};

export type ParseResult = { ok: true; invocation: Invocation } | { ok: false; reason: string };

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
