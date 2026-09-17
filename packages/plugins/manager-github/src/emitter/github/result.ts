/** What a call to the Target can end as, from this Block's point of view. */
export type TargetResult<T> =
  | { kind: "ok"; value: T }
  /** The Target refused, or nobody answered within the retries and the clock. */
  | { kind: "unreportable"; detail: string }
  | { kind: "interrupted" };

/** The bound every call of one invocation runs under. */
export type CallContext = {
  deadlineMs: number;
  now: () => number;
  shouldInterrupt: () => boolean;
};
