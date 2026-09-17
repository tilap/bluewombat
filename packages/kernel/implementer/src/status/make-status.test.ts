import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildStatusLabel, makeStatus } from "./make-status.js";

describe("buildStatusLabel", () => {
  it("builds canonical labels", () => {
    assert.equal(buildStatusLabel("building", 1, 3, undefined), "building:attempt-1:3");
    assert.equal(buildStatusLabel("gating", 1, 3, "lint"), "gating:lint:attempt-1:3");
    assert.equal(buildStatusLabel("validated", 2, 3, undefined), "validated:attempt-2:3");
    assert.equal(buildStatusLabel("escalated", 3, 3, undefined), "escalated:attempt-3:3");
    assert.equal(buildStatusLabel("interrupted", 1, 3, undefined), "interrupted:attempt-1:3");
    assert.equal(buildStatusLabel("invalid", undefined, undefined, undefined), "invalid");
  });
});

describe("makeStatus", () => {
  it("omits attempt fields on invalid", () => {
    assert.deepEqual(makeStatus({ phase: "invalid" }), {
      phase: "invalid",
      label: "invalid",
    });
  });

  it("includes gate_id only while gating", () => {
    assert.deepEqual(makeStatus({ phase: "gating", attempt: 1, maxAttempts: 3, gateId: "lint" }), {
      phase: "gating",
      attempt: 1,
      max_attempts: 3,
      gate_id: "lint",
      label: "gating:lint:attempt-1:3",
    });
  });
});
