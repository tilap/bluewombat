import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Unwrapped } from "../raw/unwrap.js";
import { type NormalizeOptions, normalize } from "./normalize.js";

const options: NormalizeOptions = {
  manager: "github",
  repo: { owner: "tilap", name: "mason" },
  defaultPriority: 50,
  projectLabelPrefix: "project:",
  priorityLabelPrefix: "priority:",
  readyLabel: "ready",
  normalizedAt: "2026-09-05T10:00:00.000Z",
};

function issue(overrides: Record<string, unknown> = {}): Unwrapped {
  return {
    issue: {
      number: 42,
      title: "Add the export button",
      body: "Users need a CSV export.",
      state: "open",
      labels: [{ name: "project:reporting" }],
      html_url: "https://github.com/tilap/mason/issues/42",
      updated_at: "2026-09-05T09:00:00Z",
      ...overrides,
    },
  };
}

function codeOf(raw: Unwrapped, over: Partial<NormalizeOptions> = {}): string | undefined {
  const result = normalize(raw, { ...options, ...over });
  return result.ok ? undefined : result.invalid.code;
}

describe("normalize", () => {
  it("converts an open issue into a FeatureStandard", () => {
    const result = normalize(issue(), options);
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.deepEqual(
      { ...result.feature, fingerprint: "…" },
      {
        key: "github:tilap/mason#42",
        manager: "github",
        external_id: "tilap/mason#42",
        intent: "upsert",
        project: "reporting",
        title: "Add the export button",
        intention: "Users need a CSV export.",
        priority: 50,
        source: {
          ref: "https://github.com/tilap/mason/issues/42",
          revision: "2026-09-05T09:00:00Z",
        },
        fingerprint: "…",
        normalized_at: "2026-09-05T10:00:00.000Z",
      },
    );
  });

  it("keeps the fingerprint stable across identical intentions, and drops the clock", () => {
    const first = normalize(issue(), options);
    const second = normalize(issue(), { ...options, normalizedAt: "2027-01-01T00:00:00.000Z" });
    const changed = normalize(issue({ title: "Add the export toggle" }), options);
    assert.equal(
      first.ok && second.ok && first.feature.fingerprint === second.feature.fingerprint,
      true,
    );
    assert.equal(
      first.ok && changed.ok && first.feature.fingerprint === changed.feature.fingerprint,
      false,
    );
  });

  it("reads the priority label, named or numeric", () => {
    const named = normalize(issue({ labels: ["project:reporting", "priority:high"] }), options);
    assert.equal(named.ok && named.feature.priority, 75);
    const numeric = normalize(issue({ labels: ["project:reporting", "priority:12"] }), options);
    assert.equal(numeric.ok && numeric.feature.priority, 12);
  });

  it("falls back to --default-project and --default-priority", () => {
    const result = normalize(issue({ labels: [] }), {
      ...options,
      defaultProject: "reporting",
      defaultPriority: 75,
    });
    assert.equal(result.ok && result.feature.project, "reporting");
    assert.equal(result.ok && result.feature.priority, 75);
  });

  it("asks nothing of a cancel beyond its identity", () => {
    const result = normalize(issue({ state: "closed", body: null, title: null }), options);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.feature.intent, "cancel");
    assert.equal(result.ok && result.feature.intention, undefined);
  });

  it("takes the body as the intention, verbatim but for what the tracker put there", () => {
    const body = "<!-- template -->\nUsers need a CSV export.\n\n- [ ] A CSV downloads";
    const result = normalize(issue({ body }), options);
    assert.equal(
      result.ok && result.feature.intention,
      "Users need a CSV export.\n\n- A CSV downloads",
    );
  });

  it("does not take a ticked box for an edit: same intention, same fingerprint", () => {
    const before = normalize(issue({ body: "Ship it.\n\n- [ ] one\n- [ ] two" }), options);
    const after = normalize(issue({ body: "Ship it.\n\n- [x] one\n- [ ] two" }), options);
    assert.ok(before.ok && after.ok);
    assert.equal(after.feature.intention, before.feature.intention);
    assert.equal(after.feature.fingerprint, before.feature.fingerprint);
  });

  it("falls back to the title when the body was only tracker noise", () => {
    const result = normalize(issue({ body: "<!-- describe it -->\n- [ ]" }), options);
    assert.equal(result.ok && result.feature.intention, "Add the export button");
  });

  it("falls back to the title when there is no body", () => {
    const result = normalize(issue({ body: null }), options);
    assert.equal(result.ok && result.feature.intention, "Add the export button");
  });

  it("refuses a pull request", () => {
    assert.equal(codeOf(issue({ pull_request: { url: "…" } })), "not-an-issue");
  });

  it("refuses an issue it cannot identify or place", () => {
    assert.equal(codeOf(issue({ number: undefined })), "missing-id");
    assert.equal(codeOf(issue({ labels: [] })), "missing-project");
    assert.equal(codeOf(issue({ labels: ["project:a", "project:b"] })), "ambiguous-project");
  });

  it("refuses an upsert with nothing to say what to do", () => {
    assert.equal(codeOf(issue({ body: null, title: null })), "missing-intention");
  });

  it("refuses a priority it cannot place on the scale", () => {
    assert.equal(codeOf(issue({ labels: ["project:p", "priority:blocker"] })), "bad-priority");
    assert.equal(codeOf(issue({ labels: ["project:p", "priority:140"] })), "bad-priority");
    assert.equal(
      codeOf(issue({ labels: ["project:p", "priority:low", "priority:high"] })),
      "bad-priority",
    );
  });

  it("refuses a recognised field of the wrong type", () => {
    assert.equal(codeOf(issue({ title: 7 })), "bad-field-type");
    assert.equal(codeOf(issue({ labels: "project:reporting" })), "bad-field-type");
  });

  it("refuses an action it does not read", () => {
    assert.equal(codeOf({ ...issue(), action: "starred" }), "unknown-action");
  });

  it("keeps no field the FeatureStandard does not declare", () => {
    const result = normalize(issue({ assignees: ["someone"], milestone: { id: 1 } }), options);
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.deepEqual(Object.keys(result.feature).includes("assignees"), false);
    assert.deepEqual(Object.keys(result.feature).includes("milestone"), false);
  });
});
