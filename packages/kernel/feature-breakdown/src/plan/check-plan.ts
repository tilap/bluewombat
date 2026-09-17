import type { RefusalCode, Subtask } from "../types.js";

export type PlanCheckOk = { ok: true; subtasks: Subtask[] };
export type PlanCheckRefused = { ok: false; code: RefusalCode; reason: string };
export type PlanCheckResult = PlanCheckOk | PlanCheckRefused;

function refused(code: RefusalCode, reason: string): PlanCheckRefused {
  return { ok: false, code, reason };
}

export function renderId(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function uniqueKeepFirst(ids: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    result.push(id);
  }
  return result;
}

function findCycle(subtasks: Subtask[]): string[] | null {
  const byId = new Map(subtasks.map((st) => [st.id, st]));
  const color = new Map<string, "white" | "gray" | "black">();
  for (const st of subtasks) {
    color.set(st.id, "white");
  }

  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    color.set(id, "gray");
    stack.push(id);
    const node = byId.get(id);
    if (node !== undefined) {
      for (const dep of node.depends_on) {
        const depColor = color.get(dep);
        if (depColor === "gray") {
          const start = stack.indexOf(dep);
          const cycle = stack.slice(start);
          cycle.push(dep);
          return cycle;
        }
        if (depColor === "white") {
          const found = visit(dep);
          if (found !== null) {
            return found;
          }
        }
      }
    }
    stack.pop();
    color.set(id, "black");
    return null;
  };

  for (const st of subtasks) {
    if (color.get(st.id) === "white") {
      const found = visit(st.id);
      if (found !== null) {
        return found;
      }
    }
  }
  return null;
}

/**
 * Check a Planner `subtasks` array. Pure: no process spawn.
 * Caller must already know `subtasks` is an array (otherwise it is not a Plan).
 */
export function checkPlan(entries: unknown[], maxUnits: number): PlanCheckResult {
  if (entries.length === 0) {
    return refused("empty-plan", "The Plan has no Subtasks. The Planner must return at least one.");
  }
  if (entries.length > maxUnits) {
    return refused(
      "plan-too-large",
      `The Plan has ${entries.length} Subtasks, which exceeds the ceiling of ${maxUnits}.`,
    );
  }

  for (const entry of entries) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return refused("bad-subtask-shape", "A Subtask entry is not an object.");
    }
  }

  const records = entries as Record<string, unknown>[];

  for (const record of records) {
    if (renderId(record.id) === null) {
      return refused("missing-subtask-id", "A Subtask has no usable id.");
    }
  }

  const ids = records.map((record) => renderId(record.id) as string);
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      return refused("duplicate-id", `Two Subtasks share the id "${id}".`);
    }
    seen.add(id);
  }
  const idSet = new Set(ids);

  for (const record of records) {
    const id = renderId(record.id) as string;
    if (typeof record.intention !== "string" || record.intention.trim().length === 0) {
      return refused("missing-subtask-intention", `Subtask "${id}" has no non-empty intention.`);
    }
  }

  for (const record of records) {
    const id = renderId(record.id) as string;
    if (
      typeof record.definition_of_done !== "string" ||
      record.definition_of_done.trim().length === 0
    ) {
      return refused(
        "missing-definition-of-done",
        `Subtask "${id}" has no non-empty definition of done.`,
      );
    }
  }

  for (const record of records) {
    if ("depends_on" in record && !Array.isArray(record.depends_on)) {
      const id = renderId(record.id) as string;
      return refused("bad-depends-on", `Subtask "${id}" has a depends_on that is not an array.`);
    }
  }

  const subtasks: Subtask[] = [];
  for (const record of records) {
    const id = renderId(record.id) as string;
    const dependsRaw = Array.isArray(record.depends_on) ? record.depends_on : [];
    const dependsOn = uniqueKeepFirst(
      dependsRaw.map((dep) => renderId(dep)).filter((dep): dep is string => dep !== null),
    );
    for (let i = 0; i < dependsRaw.length; i += 1) {
      const rendered = renderId(dependsRaw[i]);
      if (rendered === null || !idSet.has(rendered)) {
        const missing = rendered ?? String(dependsRaw[i]);
        return refused(
          "unknown-dependency",
          `Subtask "${id}" depends on "${missing}", which is not a Subtask id in this Plan.`,
        );
      }
    }
    subtasks.push({
      id,
      intention: (record.intention as string).trim(),
      definition_of_done: (record.definition_of_done as string).trim(),
      depends_on: dependsOn,
    });
  }

  const cycle = findCycle(subtasks);
  if (cycle !== null) {
    return refused("cycle", `The Plan has a dependency cycle: ${cycle.join("->")}.`);
  }

  if (subtasks.length > 0 && subtasks.every((st) => st.depends_on.length > 0)) {
    return refused("no-root", "Every Subtask depends on another; the Plan has no root.");
  }

  return { ok: true, subtasks };
}
