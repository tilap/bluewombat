import type { PlannedSubtask } from "../records.js";

export type PlanDraft = {
  id: string;
  intention: string;
  definition_of_done: string;
  depends_on: string[];
};

export type PlanCheckResult = { ok: true; subtasks: PlanDraft[] } | { ok: false };

function findCycle(subtasks: PlanDraft[]): boolean {
  const byId = new Map(subtasks.map((st) => [st.id, st]));
  const color = new Map<string, "white" | "gray" | "black">();
  for (const st of subtasks) {
    color.set(st.id, "white");
  }

  const visit = (id: string): boolean => {
    color.set(id, "gray");
    const node = byId.get(id);
    if (node !== undefined) {
      for (const dep of node.depends_on) {
        const depColor = color.get(dep);
        if (depColor === "gray") {
          return true;
        }
        if (depColor === "white" && visit(dep)) {
          return true;
        }
      }
    }
    color.set(id, "black");
    return false;
  };

  for (const st of subtasks) {
    if (color.get(st.id) === "white" && visit(st.id)) {
      return true;
    }
  }
  return false;
}

export function checkPlan(drafts: PlanDraft[]): PlanCheckResult {
  if (drafts.length === 0) {
    return { ok: false };
  }
  const seen = new Set<string>();
  for (const draft of drafts) {
    if (draft.id.length === 0 || seen.has(draft.id)) {
      return { ok: false };
    }
    seen.add(draft.id);
    if (draft.intention.trim().length === 0 || draft.definition_of_done.trim().length === 0) {
      return { ok: false };
    }
  }
  const ids = new Set(drafts.map((d) => d.id));
  for (const draft of drafts) {
    for (const dep of draft.depends_on) {
      if (!ids.has(dep)) {
        return { ok: false };
      }
    }
  }
  if (findCycle(drafts) || drafts.every((d) => d.depends_on.length > 0)) {
    return { ok: false };
  }
  return { ok: true, subtasks: drafts };
}

export function initialSubtaskState(draft: PlanDraft): PlannedSubtask["state"] {
  return draft.depends_on.length === 0 ? "runnable" : "pending";
}

export function refreshRunnable(subtasks: PlannedSubtask[]): PlannedSubtask[] {
  const integrated = new Set(subtasks.filter((st) => st.state === "integrated").map((st) => st.id));
  return subtasks.map((st) => {
    if (st.state !== "pending") {
      return st;
    }
    if (st.depends_on.every((dep) => integrated.has(dep))) {
      return { ...st, state: "runnable" };
    }
    return st;
  });
}
