import { FIELD_ORDER, type FieldName } from "../event/field-matrix.js";
import { renderMarker } from "../thread/marker.js";
import type { EventFields, EventName, EventRecord, Invocation, Stage } from "../types.js";
import { truncateText } from "./truncate.js";

/** Free-text fields the report ceiling applies to. */
const BOUNDED_FIELDS: FieldName[] = ["reason", "plan", "trace"];

/** Fields rendered as a fenced block rather than a bullet. */
const BLOCK_FIELDS: FieldName[] = ["trace"];

/** Fields that are already text a reader can read, rendered as they are. */
const PROSE_FIELDS: FieldName[] = ["plan"];

/** Said first, as a sentence: no label, no bullet. */
const LEAD_FIELDS: FieldName[] = ["summary"];

/**
 * The heading of a comment.
 *
 * The Event, in words, and nothing else: the issue page already shows who
 * commented and when, and the timestamp stays in the record below for machines.
 */
const TITLES: Record<EventName, string> = {
  invalid: "Not accepted",
  accepted: "Accepted",
  planned: "Planned",
  progress: "In progress",
  escalated: "Escalated",
  escalation_reminder: "Still escalated",
  resumed: "Resumed",
  submitted: "Submitted",
  done: "Done",
  cancelled: "Cancelled",
  reject_late: "Too late",
};

const SECTION_TITLES: Partial<Record<FieldName, string>> = {
  trace: "Trace",
  plan: "Plan",
};

/** A field whose generic name says nothing useful under a given Event. */
const FIELD_LABELS: Partial<Record<EventName, Partial<Record<FieldName, string>>>> = {
  done: { reference: "merged into", integration_reference: "commit" },
  submitted: { reference: "under review at" },
};

/** Where on the 0…100 scale a priority stops being ordinary. */
const HIGH_PRIORITY = 75;
const LOW_PRIORITY = 25;

/**
 * A fenced block does not wrap. One long line is a horizontal scroll, so a
 * Trace is folded here, on spaces, before it is fenced.
 */
const FENCE_WIDTH = 80;

export type Rendered = {
  record: EventRecord;
  /** One section for the human surface, trailing newline included. */
  section: string;
  /** The exact bytes the comment receives: the section, then the record. */
  body: string;
};

/**
 * Turn one invocation into the exact bytes the Thread receives.
 * Pure: --dry-run renders through this same function, so a preview cannot lie.
 */
export function renderEvent(invocation: Invocation): Rendered {
  const bounded = applyCeiling(invocation.fields, invocation.maxReportChars);

  // The record is what a machine needs to tell one comment from another and
  // to say it once — nothing more. The fields are in the section above it,
  // where a human reads them; repeating them here doubled every comment.
  const record: EventRecord = {
    event: invocation.event,
    key: invocation.key,
    project: invocation.project,
    at: invocation.at,
  };
  if (invocation.eventId !== undefined) {
    record.event_id = invocation.eventId;
  }
  if (bounded.truncated.length > 0) {
    record.truncated = bounded.truncated;
  }

  let section: string;
  switch (invocation.event) {
    case "invalid":
      section = renderInvalid(bounded.fields);
      break;
    case "accepted":
      section = renderAccepted(invocation, bounded.fields);
      break;
    case "planned":
      section = renderPlanned(bounded.fields);
      break;
    case "escalated":
      section = renderEscalated(bounded.fields, invocation.readyLabel);
      break;
    case "resumed":
      section = renderResumed(bounded.fields);
      break;
    case "done":
      section =
        bounded.fields.reference === undefined && bounded.fields.integration_reference === undefined
          ? renderDoneLocally()
          : renderSection(invocation, bounded.fields);
      break;
    default:
      section = renderSection(invocation, bounded.fields);
      break;
  }
  return { record, section, body: `${section}${renderMarker(record)}\n` };
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

/**
 * Dedicated comments for Events the generic field dump would mis-say.
 * Each is a string literal; `renderEvent` is what chooses this over `renderSection`.
 */
function renderInvalid(fields: EventFields): string {
  return `## Not accepted

I’m sorry, but I can’t process this issue because some of the required information is missing.

${fields.reason ?? ""}
`;
}

function renderAccepted(invocation: Invocation, fields: EventFields): string {
  const priority = typeof fields.priority === "number" ? fields.priority : 0;
  return `## Accepted

Taken in at ${priorityPhrase(priority, invocation.defaultPriority)}.
`;
}

function renderPlanned(fields: EventFields): string {
  return `## Planned

I have planned this work this issue.

${fields.plan ?? ""}
`;
}

function renderEscalated(fields: EventFields, readyLabel: string | undefined): string {
  const where = escalatedWhere(fields);
  const resume =
    readyLabel === undefined ? "" : ` Add the \`${readyLabel}\` label once it is fixed, to resume.`;
  const trace =
    fields.trace === undefined || fields.trace.length === 0
      ? ""
      : `

### Trace

\`\`\`text
${foldFence(fields.trace)}
\`\`\``;
  return `## Escalated

🙋 A human action is required to continue.

${fields.reason ?? ""}${where}

No further work starts until a human answers.${resume}${trace}
`;
}

/** A fold with no Authority: there is nothing a reader could open, so say where it went in words. */
function renderDoneLocally(): string {
  return `## Done

Folded into the work line.
`;
}

function renderResumed(fields: EventFields): string {
  const reason =
    fields.reason === undefined || fields.reason.length === 0 ? "" : `\n\n${fields.reason}`;
  return `## Resumed

Work continues from ${fields.resume_point ?? ""}.${reason}
`;
}

const STAGE_PHRASE: Record<Stage, string> = {
  plan: "while planning",
  unit: "on a Subtask",
  integrating: "while assembling the feature",
  submitting: "while the Submission was under review",
  merging: "while folding into the work line",
};

function escalatedWhere(fields: EventFields): string {
  const unit = fields.unit;
  const attempts = fields.counters?.attempts;
  if (unit !== undefined && unit.length > 0 && attempts !== undefined) {
    return `\n\nAfter ${attemptsShown(attempts)} attempts on \`${unit}\`.`;
  }
  if (unit !== undefined && unit.length > 0) {
    return `\n\nOn \`${unit}\`.`;
  }
  if (fields.stage !== undefined) {
    return `\n\nThis happened ${STAGE_PHRASE[fields.stage]}.`;
  }
  return "";
}

function attemptsShown(raw: string): string {
  const slash = /^(\d+)\/(\d+)$/.exec(raw);
  return slash === null ? raw : `${slash[1]} of ${slash[2]}`;
}

function priorityPhrase(priority: number, fallback: number | undefined): string {
  if (fallback !== undefined && priority === fallback) {
    return `priority ${priority}/100 (the default)`;
  }
  const word = priority >= HIGH_PRIORITY ? "high" : priority <= LOW_PRIORITY ? "low" : "normal";
  return `${word} priority (${priority}/100)`;
}

function renderSection(invocation: Invocation, fields: EventFields): string {
  // The key and the project are not repeated here: this comment is on that
  // issue, and the project is on its label. Both stay in the record below.
  const lines: string[] = [`## ${TITLES[invocation.event]}`];

  for (const field of LEAD_FIELDS) {
    const value = fields[field];
    if (typeof value === "string") {
      lines.push("", value);
    }
  }

  // Collected rather than pushed, so an Event carrying no bullet at all does
  // not leave a blank line standing under its heading.
  const bullets: string[] = [];
  for (const field of FIELD_ORDER) {
    if (
      BLOCK_FIELDS.includes(field) ||
      PROSE_FIELDS.includes(field) ||
      LEAD_FIELDS.includes(field)
    ) {
      continue;
    }
    const value = fields[field];
    if (value === undefined) {
      continue;
    }
    const shown =
      field === "priority" && typeof value === "number"
        ? priorityInWords(value, invocation.defaultPriority)
        : bullet(value);
    bullets.push(`- ${label(invocation.event, field)}: ${shown}`);
  }

  const note = standingNote(invocation);
  if (note !== undefined) {
    bullets.push(`- ${note}`);
  }

  if (bullets.length > 0) {
    lines.push("", ...bullets);
  }

  for (const field of PROSE_FIELDS) {
    const value = fields[field];
    if (typeof value !== "string") {
      continue;
    }
    lines.push("", `### ${title(field)}`, "", value);
  }

  for (const field of BLOCK_FIELDS) {
    const value = fields[field];
    if (typeof value !== "string") {
      continue;
    }
    lines.push("", `### ${title(field)}`, "", "```text", foldFence(value), "```");
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

/**
 * `80/100` says nothing to someone who never saw the scale. A word first, the
 * number after, and "default" when nobody chose — so a reader knows a label
 * would change it.
 */
export function priorityInWords(priority: number, fallback: number | undefined): string {
  if (fallback !== undefined && priority === fallback) {
    return `${priority}/100 (default)`;
  }
  const word = priority >= HIGH_PRIORITY ? "high" : priority <= LOW_PRIORITY ? "low" : "normal";
  return `${word} (${priority}/100)`;
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

function label(event: EventName, field: FieldName): string {
  return FIELD_LABELS[event]?.[field] ?? field.replace(/_/g, " ");
}

function title(field: FieldName): string {
  return SECTION_TITLES[field] ?? field.replace(/_/g, " ");
}

function foldFence(value: string): string {
  return value
    .split("\n")
    .flatMap((line) => foldLine(line, FENCE_WIDTH))
    .join("\n");
}

function foldLine(line: string, width: number): string[] {
  if (line.length <= width) {
    return [line];
  }
  const lines: string[] = [];
  let rest = line;
  while (rest.length > width) {
    const window = rest.slice(0, width + 1);
    const space = window.lastIndexOf(" ");
    const breakAt = space > 0 ? space : width;
    lines.push(rest.slice(0, breakAt).trimEnd());
    rest = rest.slice(breakAt).trimStart();
  }
  if (rest.length > 0) {
    lines.push(rest);
  }
  return lines;
}

function bullet(value: unknown): string {
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, string>)
      .map(([name, entry]) => `${name}=${entry}`)
      .join(", ");
  }
  return String(value);
}
