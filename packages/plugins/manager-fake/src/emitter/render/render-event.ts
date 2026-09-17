import { FIELD_ORDER, type FieldName } from "../event/field-matrix.js";
import type { EventFields, EventRecord, Invocation } from "../types.js";
import { truncateText } from "./truncate.js";

/** Free-text fields the report ceiling applies to. */
const BOUNDED_FIELDS: FieldName[] = ["reason", "plan", "trace"];

/** Fields rendered as a fenced block rather than a bullet. */
const BLOCK_FIELDS: FieldName[] = ["trace", "plan"];

export type Rendered = {
  record: EventRecord;
  /** One line for the machine surface, newline included. */
  line: string;
  /** One section for the human surface, trailing newline included. */
  section: string;
};

/**
 * Turn one invocation into the exact bytes both Thread files receive.
 * Pure: --dry-run renders through this same function, so a preview cannot lie.
 */
export function renderEvent(invocation: Invocation): Rendered {
  const bounded = applyCeiling(invocation.fields, invocation.maxReportChars);

  const record: EventRecord = {
    event: invocation.event,
    key: invocation.key,
    project: invocation.project,
    at: invocation.at,
  };
  if (invocation.eventId !== undefined) {
    record.event_id = invocation.eventId;
  }
  for (const field of FIELD_ORDER) {
    const value = bounded.fields[field];
    if (value !== undefined) {
      record[field] = value;
    }
  }
  if (bounded.truncated.length > 0) {
    record.truncated = bounded.truncated;
  }

  return {
    record,
    line: `${JSON.stringify(record)}\n`,
    section: renderSection(invocation, bounded.fields),
  };
}

function applyCeiling(
  fields: EventFields,
  maxChars: number,
): { fields: EventFields; truncated: string[] } {
  const out: EventFields = { ...fields };
  const truncated: string[] = [];
  for (const field of BOUNDED_FIELDS) {
    const value = out[field];
    if (typeof value !== "string") {
      continue;
    }
    const cut = truncateText(value, maxChars);
    if (cut.truncated) {
      truncated.push(field);
      (out as Record<string, unknown>)[field] = cut.text;
    }
  }
  return { fields: out, truncated };
}

function renderSection(invocation: Invocation, fields: EventFields): string {
  const lines: string[] = [
    `## ${invocation.at} — ${invocation.event}`,
    "",
    `- project: ${invocation.project}`,
  ];

  for (const field of FIELD_ORDER) {
    if (BLOCK_FIELDS.includes(field) || field === "summary") {
      continue;
    }
    const value = fields[field];
    if (value === undefined) {
      continue;
    }
    lines.push(`- ${label(field)}: ${bullet(value)}`);
  }
  if (typeof fields.summary === "string") {
    lines.splice(2, 0, fields.summary, "");
  }

  const note = standingNote(invocation);
  if (note !== undefined) {
    lines.push(`- ${note}`);
  }

  for (const field of BLOCK_FIELDS) {
    const value = fields[field];
    if (typeof value !== "string") {
      continue;
    }
    lines.push("", `### ${title(field)}`, "", "```text", value, "```");
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

/** What a reader must be told about this Event beyond its fields. */
function standingNote(invocation: Invocation): string | undefined {
  switch (invocation.event) {
    case "escalated":
      return "frozen: no further work starts until a human answers";
    case "escalation_reminder":
      return "frozen: still waiting, this is a repeat of an earlier escalation";
    case "reject_late":
      return "too late: this arrived after the point of no return";
    default:
      return undefined;
  }
}

function label(field: FieldName): string {
  return field.replace(/_/g, " ");
}

function title(field: FieldName): string {
  return field === "trace" ? "Trace" : "Plan";
}

function bullet(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry)).join("; ");
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, string>)
      .map(([name, entry]) => `${name}=${entry}`)
      .join(", ");
  }
  return String(value);
}
