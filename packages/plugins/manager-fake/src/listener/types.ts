/** Domain types owned by FeatureListener. Names match the Block perimeter only. */

export type RunOutcome = "completed" | "source-lost" | "invalid-invocation" | "interrupted";

export type StopReason = "drained" | "max-events" | "duration" | "source-lost" | "signal";

export type SkipReason = "unreadable" | "not-json" | "not-object";

export type Invocation = {
  manager: string;
  source: string;
  /** Deliver only Events whose Cursor is strictly greater. */
  since?: string;
  follow: boolean;
  pollIntervalMs?: number;
  maxEvents: number;
  durationMs: number;
  onIntentionArgv?: string[];
};

export type ParseResult = { ok: true; invocation: Invocation } | { ok: false; reason: string };

export type Delivery = {
  cursor: string;
  bytes: number;
  payload: Record<string, unknown>;
};

export type Skip = {
  cursor: string;
  reason: SkipReason;
  detail: string;
};

export type ReadEventResult =
  | { ok: true; payload: Record<string, unknown>; bytes: number }
  | { ok: false; reason: SkipReason; detail: string };
