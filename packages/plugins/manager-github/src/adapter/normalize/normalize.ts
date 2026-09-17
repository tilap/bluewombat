import type { Unwrapped } from "../raw/unwrap.js";
import type { FeatureStandard, Invalid, NormalizeResult, Repository } from "../types.js";
import { fingerprintOf } from "./fingerprint.js";
import { readIntent } from "./intent.js";
import { readLabels, valuesWithPrefix } from "./labels.js";
import { stripTrackerNoise } from "./noise.js";

export type NormalizeOptions = {
  manager: string;
  repo: Repository;
  defaultProject?: string;
  defaultPriority: number;
  projectLabelPrefix: string;
  priorityLabelPrefix: string;
  readyLabel: string;
  normalizedAt: string;
};

const PRIORITY_NAMES: Record<string, number> = {
  low: 25,
  normal: 50,
  high: 75,
  urgent: 100,
};

function badType(field: string, value: unknown): Invalid {
  return {
    code: "bad-field-type",
    reason: `Field "${field}" is ${describe(value)}, which this Block cannot read.`,
  };
}

function describe(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "an array";
  }
  return `a ${typeof value}`;
}

/** A recognised field is either absent, or of a shape this Block reads. */
type FieldResult<T> = { ok: true; value?: T } | { ok: false; invalid: Invalid };

function readString(issue: Record<string, unknown>, field: string): FieldResult<string> {
  const value = issue[field];
  if (value === undefined || value === null) {
    return { ok: true };
  }
  if (typeof value !== "string") {
    return { ok: false, invalid: badType(field, value) };
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? { ok: true } : { ok: true, value: trimmed };
}

/** The issue number, as GitHub writes it or as a caller typed it. */
function readNumber(issue: Record<string, unknown>): FieldResult<number> {
  const value = issue.number;
  if (value === undefined || value === null) {
    return { ok: true };
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 1) {
      return { ok: false, invalid: badType("number", value) };
    }
    return { ok: true, value };
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return { ok: true, value: Number(value.trim()) };
  }
  return { ok: false, invalid: badType("number", value) };
}

function readPriority(values: string[], prefix: string): FieldResult<number> {
  if (values.length === 0) {
    return { ok: true };
  }
  if (values.length > 1) {
    return {
      ok: false,
      invalid: {
        code: "bad-priority",
        reason: `The issue carries ${values.length} "${prefix}" labels: ${values.join(", ")}.`,
      },
    };
  }
  const raw = values[0] ?? "";
  const named = PRIORITY_NAMES[raw.toLowerCase()];
  if (named !== undefined) {
    return { ok: true, value: named };
  }
  if (/^\d+$/.test(raw)) {
    const value = Number(raw);
    if (value >= 0 && value <= 100) {
      return { ok: true, value };
    }
    return {
      ok: false,
      invalid: { code: "bad-priority", reason: `Priority ${value} is outside the 0…100 scale.` },
    };
  }
  return {
    ok: false,
    invalid: {
      code: "bad-priority",
      reason: `Priority "${raw}" is not one of low, normal, high, urgent, or 0…100.`,
    },
  };
}

/**
 * Turn one issue into a FeatureStandard, or say why it cannot be one. Pure: no
 * clock, no request, no file.
 *
 * Checks run in a fixed order — the pull-request refusal, then every recognised
 * field's type, then the action, then the fields the intent requires, then the
 * priority scale — so one raw intention always produces the same code.
 */
export function normalize(raw: Unwrapped, options: NormalizeOptions): NormalizeResult {
  const { issue } = raw;

  if (issue.pull_request !== undefined && issue.pull_request !== null) {
    return {
      ok: false,
      invalid: {
        code: "not-an-issue",
        reason: "The raw intention is a pull request; only the issue tracker is read here.",
      },
    };
  }

  const number = readNumber(issue);
  if (!number.ok) {
    return { ok: false, invalid: number.invalid };
  }
  const title = readString(issue, "title");
  if (!title.ok) {
    return { ok: false, invalid: title.invalid };
  }
  const body = readString(issue, "body");
  if (!body.ok) {
    return { ok: false, invalid: body.invalid };
  }
  const state = readString(issue, "state");
  if (!state.ok) {
    return { ok: false, invalid: state.invalid };
  }
  const ref = readString(issue, "html_url");
  if (!ref.ok) {
    return { ok: false, invalid: ref.invalid };
  }
  const revision = readString(issue, "updated_at");
  if (!revision.ok) {
    return { ok: false, invalid: revision.invalid };
  }
  const labels = readLabels(issue);
  if (!labels.ok) {
    return { ok: false, invalid: labels.invalid };
  }

  const intent = readIntent({
    action: raw.action,
    state: state.value,
    labels: labels.names,
    readyLabel: options.readyLabel,
  });
  if (!intent.ok) {
    return { ok: false, invalid: intent.invalid };
  }

  if (number.value === undefined) {
    return {
      ok: false,
      invalid: { code: "missing-id", reason: 'The raw intention carries no issue "number".' },
    };
  }

  const projects = valuesWithPrefix(labels.names, options.projectLabelPrefix);
  if (projects.length > 1) {
    return {
      ok: false,
      invalid: {
        code: "ambiguous-project",
        reason: `The issue carries ${projects.length} "${options.projectLabelPrefix}" labels: ${projects.join(", ")}.`,
      },
    };
  }
  const project = projects[0] ?? options.defaultProject;
  if (project === undefined) {
    return {
      ok: false,
      invalid: {
        code: "missing-project",
        reason: `No "${options.projectLabelPrefix}" label on the issue and no --default-project.`,
      },
    };
  }

  // The body as the human wrote it, less what the tracker put there: a
  // template's comments and a task list's boxes are not an intention, and
  // ticking a box must not read as an edit. A body that was only that falls
  // back to the title, like no body at all.
  const written = body.value === undefined ? undefined : stripTrackerNoise(body.value);
  const intention = written === undefined || written.length === 0 ? title.value : written;
  if (intent.intent === "upsert" && intention === undefined) {
    return {
      ok: false,
      invalid: {
        code: "missing-intention",
        reason: 'An upsert needs a body or, failing that, a "title".',
      },
    };
  }

  const priority = readPriority(
    valuesWithPrefix(labels.names, options.priorityLabelPrefix),
    options.priorityLabelPrefix,
  );
  if (!priority.ok) {
    return { ok: false, invalid: priority.invalid };
  }

  const source: { ref?: string; revision?: string } = {};
  if (ref.value !== undefined) {
    source.ref = ref.value;
  }
  if (revision.value !== undefined) {
    source.revision = revision.value;
  }

  const externalId = `${options.repo.owner}/${options.repo.name}#${number.value}`;

  // Built in the order the FeatureStandard documents, so stdout reads top-down.
  const feature: FeatureStandard = {
    key: `${options.manager}:${externalId}`,
    manager: options.manager,
    external_id: externalId,
    intent: intent.intent,
    project,
    ...(title.value !== undefined ? { title: title.value } : {}),
    ...(intention !== undefined ? { intention } : {}),
    priority: priority.value ?? options.defaultPriority,
    ...(Object.keys(source).length > 0 ? { source } : {}),
    fingerprint: "",
    normalized_at: options.normalizedAt,
  };

  feature.fingerprint = fingerprintOf(feature as unknown as Record<string, unknown>);
  return { ok: true, feature };
}
