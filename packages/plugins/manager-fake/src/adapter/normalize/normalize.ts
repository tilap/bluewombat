import type { FeatureStandard, Intent, Invalid, NormalizeResult } from "../types.js";
import { fingerprintOf } from "./fingerprint.js";

export type NormalizeOptions = {
  manager: string;
  defaultProject?: string;
  defaultPriority: number;
  normalizedAt: string;
};

const KIND_TO_INTENT: Record<string, Intent> = {
  create: "upsert",
  update: "upsert",
  ready: "ready",
  cancel: "cancel",
  delete: "cancel",
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

function readString(raw: Record<string, unknown>, field: string): FieldResult<string> {
  const value = raw[field];
  if (value === undefined) {
    return { ok: true };
  }
  if (typeof value !== "string") {
    return { ok: false, invalid: badType(field, value) };
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? { ok: true } : { ok: true, value: trimmed };
}

function readIdLike(raw: Record<string, unknown>, field: string): FieldResult<string> {
  const value = raw[field];
  if (value === undefined) {
    return { ok: true };
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return { ok: true, value: String(value) };
  }
  if (typeof value !== "string") {
    return { ok: false, invalid: badType(field, value) };
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? { ok: true } : { ok: true, value: trimmed };
}

function readPriority(raw: Record<string, unknown>): FieldResult<number> {
  const value = raw.priority;
  if (value === undefined) {
    return { ok: true };
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0 || value > 100) {
      return {
        ok: false,
        invalid: {
          code: "bad-priority",
          reason: `Priority ${value} is outside the 0…100 scale.`,
        },
      };
    }
    return { ok: true, value };
  }
  if (typeof value !== "string") {
    return { ok: false, invalid: badType("priority", value) };
  }
  const named = PRIORITY_NAMES[value.trim().toLowerCase()];
  if (named === undefined) {
    return {
      ok: false,
      invalid: {
        code: "bad-priority",
        reason: `Priority "${value}" is not one of low, normal, high, urgent.`,
      },
    };
  }
  return { ok: true, value: named };
}

function readKind(raw: Record<string, unknown>): FieldResult<Intent> {
  const value = raw.kind;
  if (value === undefined) {
    return { ok: true, value: "upsert" };
  }
  if (typeof value !== "string") {
    return { ok: false, invalid: badType("kind", value) };
  }
  const intent = KIND_TO_INTENT[value.trim().toLowerCase()];
  if (intent === undefined) {
    return {
      ok: false,
      invalid: {
        code: "unknown-kind",
        reason: `Kind "${value}" is not one of create, update, ready, cancel, delete.`,
      },
    };
  }
  return { ok: true, value: intent };
}

/**
 * Turn a parsed raw intention into a FeatureStandard, or say why it cannot be
 * one. Pure: no clock, no child process, no file.
 *
 * Checks run in a fixed order — every recognised field's type first, then the
 * kind, then the fields the intent requires, then the priority scale — so one
 * raw intention always produces the same code.
 */
export function normalize(
  raw: Record<string, unknown>,
  options: NormalizeOptions,
): NormalizeResult {
  const externalId = readIdLike(raw, "id");
  if (!externalId.ok) {
    return { ok: false, invalid: externalId.invalid };
  }
  const project = readString(raw, "project");
  if (!project.ok) {
    return { ok: false, invalid: project.invalid };
  }
  const title = readString(raw, "title");
  if (!title.ok) {
    return { ok: false, invalid: title.invalid };
  }
  const intention = readString(raw, "intention");
  if (!intention.ok) {
    return { ok: false, invalid: intention.invalid };
  }
  const ref = readString(raw, "url");
  if (!ref.ok) {
    return { ok: false, invalid: ref.invalid };
  }
  const revision = readIdLike(raw, "revision");
  if (!revision.ok) {
    return { ok: false, invalid: revision.invalid };
  }

  const kind = readKind(raw);
  if (!kind.ok) {
    return { ok: false, invalid: kind.invalid };
  }
  const intent = kind.value ?? "upsert";

  if (externalId.value === undefined) {
    return {
      ok: false,
      invalid: { code: "missing-id", reason: 'The raw intention carries no usable "id".' },
    };
  }

  const resolvedProject = project.value ?? options.defaultProject;
  if (resolvedProject === undefined) {
    return {
      ok: false,
      invalid: {
        code: "missing-project",
        reason: 'No "project" in the raw intention and no --default-project.',
      },
    };
  }

  const resolvedIntention = intention.value ?? title.value;
  if (intent === "upsert" && resolvedIntention === undefined) {
    return {
      ok: false,
      invalid: {
        code: "missing-intention",
        reason: 'An upsert needs an "intention" or, failing that, a "title".',
      },
    };
  }

  const priority = readPriority(raw);
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

  // Built in the order the FeatureStandard documents, so stdout reads top-down.
  const feature: FeatureStandard = {
    key: `${options.manager}:${externalId.value}`,
    manager: options.manager,
    external_id: externalId.value,
    intent,
    project: resolvedProject,
    ...(title.value !== undefined ? { title: title.value } : {}),
    ...(resolvedIntention !== undefined ? { intention: resolvedIntention } : {}),
    priority: priority.value ?? options.defaultPriority,
    ...(Object.keys(source).length > 0 ? { source } : {}),
    fingerprint: "",
    normalized_at: options.normalizedAt,
  };

  feature.fingerprint = fingerprintOf(feature as unknown as Record<string, unknown>);
  return { ok: true, feature };
}
