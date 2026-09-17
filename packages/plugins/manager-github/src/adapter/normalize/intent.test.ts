import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readIntent } from "./intent.js";

function intentOf(input: {
  action?: string;
  state?: string;
  labels?: string[];
}): string | undefined {
  const result = readIntent({
    action: input.action,
    state: input.state,
    labels: input.labels ?? [],
    readyLabel: "ready",
  });
  return result.ok ? result.intent : undefined;
}

describe("readIntent", () => {
  it("reads a snapshot from its state alone", () => {
    assert.equal(intentOf({ state: "open" }), "upsert");
    assert.equal(intentOf({ state: "closed" }), "cancel");
    assert.equal(intentOf({}), "upsert");
  });

  it("ignores the ready label on a snapshot, which cannot see the edge", () => {
    assert.equal(intentOf({ state: "open", labels: ["ready"] }), "upsert");
  });

  it("collapses the actions a repository sends", () => {
    assert.equal(intentOf({ action: "opened" }), "upsert");
    assert.equal(intentOf({ action: "edited" }), "upsert");
    assert.equal(intentOf({ action: "closed" }), "cancel");
    assert.equal(intentOf({ action: "deleted" }), "cancel");
    assert.equal(intentOf({ action: "transferred" }), "cancel");
  });

  it("reads the arrival of the ready label as the human unblocking it", () => {
    assert.equal(intentOf({ action: "labeled", labels: ["ready"] }), "ready");
    assert.equal(intentOf({ action: "labeled", labels: ["bug"] }), "upsert");
    assert.equal(intentOf({ action: "unlabeled", labels: ["ready"] }), "upsert");
  });

  it("refuses an action it does not read", () => {
    const result = readIntent({
      action: "starred",
      state: "open",
      labels: [],
      readyLabel: "ready",
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.invalid.code, "unknown-action");
  });
});
