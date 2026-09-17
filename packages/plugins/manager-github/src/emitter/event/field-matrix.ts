import type { EventFields, EventName } from "../types.js";

export type FieldName = keyof EventFields;

/** Column order of the matrix: it also orders a rendered section. */
export const FIELD_ORDER: FieldName[] = [
  "summary",
  "reason",
  "stage",
  "trace",
  "counters",
  "plan",
  "priority",
  "unit",
  "remaining",
  "state",
  "resume_point",
  "reference",
  "integration_reference",
  "workspace_ref",
];

export const EVENT_NAMES: EventName[] = [
  "invalid",
  "accepted",
  "planned",
  "progress",
  "escalated",
  "escalation_reminder",
  "resumed",
  "submitted",
  "done",
  "cancelled",
  "reject_late",
];

type Rule = { required: FieldName[]; optional: FieldName[] };

/**
 * What each Event accepts. A field outside its row is refused, not dropped:
 * a caller setting `reference` on `planned` has confused two Events, and a
 * report that hides that is worse than a refusal.
 */
export const FIELD_MATRIX: Record<EventName, Rule> = {
  invalid: { required: ["reason"], optional: [] },
  accepted: { required: ["priority"], optional: [] },
  planned: { required: ["plan"], optional: [] },
  // Progress is one sentence a person reads — a Subtask landed, a refusal
  // being repaired — and whatever detail the caller wants to leave under it.
  progress: {
    required: ["summary"],
    optional: ["unit", "remaining", "state", "stage", "reason", "trace", "counters"],
  },
  escalated: {
    required: ["reason", "stage"],
    optional: ["trace", "counters", "unit"],
  },
  escalation_reminder: {
    required: ["reason", "stage"],
    optional: ["trace", "counters", "unit"],
  },
  resumed: { required: ["resume_point"], optional: ["reason"] },
  // The work is in front of the Authority; the reference is where it can be seen.
  submitted: { required: ["reference"], optional: [] },
  // A local fold names nothing a reader could open; only an Authority's fold has a reference.
  done: { required: [], optional: ["reference", "integration_reference"] },
  cancelled: { required: ["state"], optional: ["reason", "workspace_ref"] },
  reject_late: { required: ["reason"], optional: ["state", "reference"] },
};

export type ValidationResult = { ok: true } | { ok: false; reason: string };

/**
 * Check one Event's fields against the matrix, plus the two rules on top of it.
 * Pure: no directory, no clock.
 */
export function validateFields(event: EventName, fields: EventFields): ValidationResult {
  const rule = FIELD_MATRIX[event];
  const allowed = new Set<FieldName>([...rule.required, ...rule.optional]);

  const given = FIELD_ORDER.filter((field) => fields[field] !== undefined);
  const refused = given.filter((field) => !allowed.has(field));
  if (refused.length > 0) {
    return {
      ok: false,
      reason: `Event "${event}" does not accept: ${refused.map(flagOf).join(", ")}.`,
    };
  }

  const missing = rule.required.filter((field) => fields[field] === undefined);
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `Event "${event}" requires: ${missing.map(flagOf).join(", ")}.`,
    };
  }

  // An escalation about work that ran, without what it left behind, forces a
  // human to reproduce the failure before they can understand it.
  if (fields.stage === "unit" && fields.trace === undefined) {
    return { ok: false, reason: 'Stage "unit" requires --trace or --trace-file.' };
  }

  return { ok: true };
}

export function flagOf(field: FieldName): string {
  return `--${field.replace(/_/g, "-")}`;
}
