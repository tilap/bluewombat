const DEFAULT_REFUSAL_REASON = "The Planner refused the FeatureStandard without saying why.";

export type PlannerParsed =
  | { kind: "plan"; subtasks: unknown[] }
  | { kind: "refused"; reason: string }
  | { kind: "unusable" };

function asObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/**
 * Parse Planner stdout. Pure: no process spawn.
 * Refusal wins when both `outcome: "refused"` and `subtasks` are present.
 */
export function parsePlannerStdout(stdout: string): PlannerParsed {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return { kind: "unusable" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return { kind: "unusable" };
  }
  const record = asObject(parsed);
  if (record === null) {
    return { kind: "unusable" };
  }

  if (record.outcome === "refused") {
    const reason =
      typeof record.reason === "string" && record.reason.trim().length > 0
        ? record.reason.trim()
        : DEFAULT_REFUSAL_REASON;
    return { kind: "refused", reason };
  }

  if (!Array.isArray(record.subtasks)) {
    return { kind: "unusable" };
  }
  return { kind: "plan", subtasks: record.subtasks };
}
