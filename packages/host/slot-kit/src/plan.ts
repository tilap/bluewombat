export type PlanSubtask = {
  id: string;
  intention: string;
  definition_of_done: string;
  depends_on: string[];
};

export type CheckedPlan = { ok: true; subtasks: PlanSubtask[] } | { ok: false; reason: string };

/**
 * Whether this is a Plan the rest of the system can act on — and, when it is,
 * the subtasks typed as one.
 *
 * Checked here rather than trusted, because a Planner that hands back a broken
 * graph has failed at its one job, and the failure should read as this slot's,
 * not as a refusal of the feature.
 */
export function checkPlan(subtasks: unknown, maxUnits?: number): CheckedPlan {
  if (!Array.isArray(subtasks) || subtasks.length === 0) {
    return { ok: false, reason: "The plan has no subtasks." };
  }
  if (maxUnits !== undefined && Number.isInteger(maxUnits) && subtasks.length > maxUnits) {
    return {
      ok: false,
      reason: `The plan has ${subtasks.length} subtasks, over the ${maxUnits} allowed.`,
    };
  }
  const ids = new Set<string>();
  for (const subtask of subtasks as unknown[]) {
    if (subtask === null || typeof subtask !== "object") {
      return { ok: false, reason: "A subtask is not an object." };
    }
    const record = subtask as Record<string, unknown>;
    for (const field of ["id", "intention", "definition_of_done"]) {
      const value = record[field];
      if (typeof value !== "string" || value.trim().length === 0) {
        return { ok: false, reason: `A subtask has no "${field}".` };
      }
    }
    const id = record.id as string;
    if (ids.has(id)) {
      return { ok: false, reason: `Two subtasks share the id "${id}".` };
    }
    ids.add(id);
    if (!Array.isArray(record.depends_on)) {
      return { ok: false, reason: `Subtask "${id}" has no depends_on list.` };
    }
  }
  const plan = subtasks as PlanSubtask[];
  for (const subtask of plan) {
    for (const dependency of subtask.depends_on) {
      if (dependency === subtask.id) {
        return { ok: false, reason: `Subtask "${subtask.id}" depends on itself.` };
      }
      if (!ids.has(dependency)) {
        return {
          ok: false,
          reason: `Subtask "${subtask.id}" depends on "${dependency}", which is not in the plan.`,
        };
      }
    }
  }
  const cycle = findCycle(plan);
  if (cycle !== undefined) {
    return { ok: false, reason: `The plan has a cycle: ${cycle.join(" → ")}.` };
  }
  return { ok: true, subtasks: plan };
}

/** Depth-first, so the answer names the loop rather than only reporting one. */
function findCycle(subtasks: readonly PlanSubtask[]): string[] | undefined {
  const edges = new Map(subtasks.map((subtask) => [subtask.id, subtask.depends_on]));
  const done = new Set<string>();
  const path: string[] = [];
  const open = new Set<string>();

  const walk = (id: string): string[] | undefined => {
    if (done.has(id)) {
      return undefined;
    }
    if (open.has(id)) {
      return [...path.slice(path.indexOf(id)), id];
    }
    open.add(id);
    path.push(id);
    for (const next of edges.get(id) ?? []) {
      const found = walk(next);
      if (found !== undefined) {
        return found;
      }
    }
    path.pop();
    open.delete(id);
    done.add(id);
    return undefined;
  };

  for (const subtask of subtasks) {
    const found = walk(subtask.id);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}
