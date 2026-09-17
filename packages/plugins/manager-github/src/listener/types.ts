/** Domain types owned by FeatureListener. Names match the Block perimeter only. */

export type RunOutcome = "completed" | "source-lost" | "invalid-invocation" | "interrupted";

export type StopReason = "drained" | "max-events" | "duration" | "source-lost" | "signal";

export type SkipReason = "not-object" | "no-cursor";

/** The Source: one repository's issues. */
export type Repository = { owner: string; name: string };

export type IssueState = "open" | "closed" | "all";

export type Invocation = {
  manager: string;
  repo: Repository;
  /** Root of the REST API, so a GitHub Enterprise host is one argument away. */
  apiBase: string;
  state: IssueState;
  /** Every label an Event must carry; empty means no label filter. */
  labels: string[];
  /** Deliver only Events whose Cursor is strictly greater. */
  since?: string;
  follow: boolean;
  pollIntervalMs?: number;
  maxEvents: number;
  durationMs: number;
  perPage: number;
  /** Extra attempts after the first, on a transport failure, a 5xx, or a rate limit. */
  requestRetries: number;
  onIntentionArgv?: string[];
};

export type ParseResult =
  /** The token is beside the Invocation, never inside it: it is not part of what a run describes. */
  { ok: true; invocation: Invocation; token: string } | { ok: false; reason: string };

/** What a Cursor is made of: when the issue last moved, and which issue it is. */
export type Cursor = { updatedAt: string; number: number };

/** One line on stdout: an issue that was read and passed through. */
export type Delivery = {
  cursor: string;
  bytes: number;
  payload: Record<string, unknown>;
};

/** An entry that was not a readable issue. It has no Cursor to commit. */
export type Skip = {
  reason: SkipReason;
  detail: string;
};
