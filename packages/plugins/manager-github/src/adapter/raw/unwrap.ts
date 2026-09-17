/**
 * A raw intention arrives in one of two shapes: the issue GitHub listed, or the
 * envelope GitHub sends about an issue (`{ "action": …, "issue": { … } }`).
 * Both are read, so a subscription and a webhook relay feed the same Block.
 */

export type Unwrapped = {
  issue: Record<string, unknown>;
  /** What just happened to the issue; absent when the raw intention is a snapshot. */
  action?: string;
};

export function unwrapIssue(raw: Record<string, unknown>): Unwrapped {
  const inner = raw.issue;
  const issue =
    inner !== null && typeof inner === "object" && !Array.isArray(inner)
      ? (inner as Record<string, unknown>)
      : raw;
  const action = raw.action;
  return {
    issue,
    ...(typeof action === "string" && action.trim().length > 0
      ? { action: action.trim().toLowerCase() }
      : {}),
  };
}
