import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NormalizeOptions } from "./normalize.js";
import { normalize } from "./normalize.js";

const options: NormalizeOptions = {
  manager: "fake",
  defaultPriority: 50,
  normalizedAt: "2026-09-05T10:00:00.000Z",
};

function upsertRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "42",
    project: "reporting",
    intention: "Users need a CSV export",
    ...overrides,
  };
}

function invalidCode(raw: Record<string, unknown>, opts: NormalizeOptions = options): string {
  const result = normalize(raw, opts);
  assert.equal(result.ok, false);
  return result.ok ? "" : result.invalid.code;
}

describe("normalize", () => {
  it("converts a complete upsert", () => {
    const result = normalize(upsertRaw(), options);
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.feature.key, "fake:42");
    assert.equal(result.feature.manager, "fake");
    assert.equal(result.feature.external_id, "42");
    assert.equal(result.feature.intent, "upsert");
    assert.equal(result.feature.project, "reporting");
    assert.equal(result.feature.priority, 50);
    assert.match(result.feature.fingerprint, /^sha256:[0-9a-f]{64}$/);
  });

  it("renders a numeric id as its decimal string", () => {
    const result = normalize(upsertRaw({ id: 42 }), options);
    assert.equal(result.ok && result.feature.external_id, "42");
  });

  it("is stable: same input, same fingerprint", () => {
    const first = normalize(upsertRaw(), options);
    const second = normalize(upsertRaw(), options);
    assert.equal(
      first.ok && second.ok && first.feature.fingerprint === second.feature.fingerprint,
      true,
    );
  });

  it("changes the fingerprint when the intention changes", () => {
    const first = normalize(upsertRaw(), options);
    const second = normalize(upsertRaw({ intention: "Users need a CSV export!" }), options);
    assert.notEqual(first.ok && first.feature.fingerprint, second.ok && second.feature.fingerprint);
  });

  it("leaves the fingerprint alone when only the timestamp changes", () => {
    const first = normalize(upsertRaw(), options);
    const second = normalize(upsertRaw(), {
      ...options,
      normalizedAt: "2027-01-01T00:00:00.000Z",
    });
    assert.equal(
      first.ok && second.ok && first.feature.fingerprint === second.feature.fingerprint,
      true,
    );
  });

  it("maps every kind onto an intent", () => {
    const cases: Array<[string, string]> = [
      ["create", "upsert"],
      ["update", "upsert"],
      ["ready", "ready"],
      ["cancel", "cancel"],
      ["delete", "cancel"],
    ];
    for (const [kind, intent] of cases) {
      const result = normalize(upsertRaw({ kind }), options);
      assert.equal(result.ok && result.feature.intent, intent, `kind ${kind}`);
    }
  });

  it("defaults a missing kind to upsert", () => {
    const result = normalize(upsertRaw(), options);
    assert.equal(result.ok && result.feature.intent, "upsert");
  });

  it("accepts a ready signal carrying only an identity", () => {
    const result = normalize({ id: "42", project: "reporting", kind: "ready" }, options);
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.feature.intent, "ready");
    assert.equal(result.feature.intention, undefined);
  });

  it("falls back to --default-project", () => {
    const raw = upsertRaw();
    delete raw.project;
    const result = normalize(raw, { ...options, defaultProject: "fallback" });
    assert.equal(result.ok && result.feature.project, "fallback");
  });

  it("falls back from intention to title", () => {
    const raw = upsertRaw({ title: "Add the export button" });
    delete raw.intention;
    const result = normalize(raw, options);
    assert.equal(result.ok && result.feature.intention, "Add the export button");
  });

  it("reads the four priority names and integers alike", () => {
    const cases: Array<[unknown, number]> = [
      ["low", 25],
      ["normal", 50],
      ["high", 75],
      ["urgent", 100],
      [0, 0],
      [100, 100],
      [63, 63],
    ];
    for (const [value, expected] of cases) {
      const result = normalize(upsertRaw({ priority: value }), options);
      assert.equal(result.ok && result.feature.priority, expected, `priority ${String(value)}`);
    }
  });

  it("keeps the source back link", () => {
    const result = normalize(upsertRaw({ url: "https://example.test/42", revision: 7 }), options);
    assert.deepEqual(result.ok && result.feature.source, {
      ref: "https://example.test/42",
      revision: "7",
    });
  });

  it("drops fields it does not recognise", () => {
    const result = normalize(upsertRaw({ assignee: "someone", labels: ["a"] }), options);
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.deepEqual(Object.keys(result.feature).sort(), [
      "external_id",
      "fingerprint",
      "intent",
      "intention",
      "key",
      "manager",
      "normalized_at",
      "priority",
      "project",
    ]);
  });

  it("carries no state, counters, or bail", () => {
    const result = normalize(upsertRaw(), options);
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    const document = result.feature as unknown as Record<string, unknown>;
    for (const field of ["state", "attempts", "lease", "received_at"]) {
      assert.equal(field in document, false, field);
    }
  });

  it("refuses an upsert with no id", () => {
    const raw = upsertRaw();
    delete raw.id;
    assert.equal(invalidCode(raw), "missing-id");
  });

  it("refuses a project it cannot resolve", () => {
    const raw = upsertRaw();
    delete raw.project;
    assert.equal(invalidCode(raw), "missing-project");
  });

  it("refuses an upsert with neither intention nor title", () => {
    const raw = upsertRaw();
    delete raw.intention;
    assert.equal(invalidCode(raw), "missing-intention");
  });

  it("refuses an unknown kind", () => {
    assert.equal(invalidCode(upsertRaw({ kind: "archived" })), "unknown-kind");
  });

  it("refuses a priority outside the scale or off the name list", () => {
    assert.equal(invalidCode(upsertRaw({ priority: 140 })), "bad-priority");
    assert.equal(invalidCode(upsertRaw({ priority: -1 })), "bad-priority");
    assert.equal(invalidCode(upsertRaw({ priority: 1.5 })), "bad-priority");
    assert.equal(invalidCode(upsertRaw({ priority: "blocker" })), "bad-priority");
  });

  it("refuses a recognised field of the wrong type instead of falling back", () => {
    assert.equal(invalidCode(upsertRaw({ priority: {} })), "bad-field-type");
    assert.equal(invalidCode(upsertRaw({ project: 7 })), "bad-field-type");
    assert.equal(invalidCode(upsertRaw({ intention: ["a"] })), "bad-field-type");
    assert.equal(invalidCode(upsertRaw({ id: null })), "bad-field-type");
    assert.equal(invalidCode(upsertRaw({ kind: 3 })), "bad-field-type");
  });
});
