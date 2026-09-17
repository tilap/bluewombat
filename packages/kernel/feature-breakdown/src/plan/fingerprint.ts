import { createHash } from "node:crypto";
import type { Subtask } from "../types.js";

/**
 * Canonical JSON of `key` and `subtasks` for the fingerprint.
 * Subtasks are sorted by id; each depends_on list is sorted.
 * The emitted Plan still uses the Planner's order.
 */
export function canonicalPlanJson(key: string, subtasks: Subtask[]): string {
  const sorted = [...subtasks]
    .map((st) => ({
      id: st.id,
      intention: st.intention,
      definition_of_done: st.definition_of_done,
      depends_on: [...st.depends_on].sort(),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return JSON.stringify({ key, subtasks: sorted });
}

export function fingerprintPlan(key: string, subtasks: Subtask[]): string {
  const hex = createHash("sha256").update(canonicalPlanJson(key, subtasks), "utf8").digest("hex");
  return `sha256:${hex}`;
}
