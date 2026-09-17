import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildStatusLabel, makeStatus } from "./make-status.js";

describe("buildStatusLabel", () => {
  it("builds canonical labels", () => {
    assert.equal(buildStatusLabel("integrating", "feat-1"), "integrating:feat-1");
    assert.equal(buildStatusLabel("integrated", "feat-1"), "integrated:feat-1");
    assert.equal(buildStatusLabel("conflict", "feat-1"), "conflict:feat-1");
    assert.equal(buildStatusLabel("failed", "feat-1"), "failed:feat-1");
    assert.equal(buildStatusLabel("interrupted", "feat-1"), "interrupted:feat-1");
    assert.equal(buildStatusLabel("invalid", undefined), "invalid");
  });
});

describe("makeStatus", () => {
  it("omits id on invalid when id is unusable", () => {
    assert.deepEqual(makeStatus({ phase: "invalid" }), {
      phase: "invalid",
      label: "invalid",
    });
  });

  it("keeps id on invalid when --id is usable", () => {
    assert.deepEqual(makeStatus({ phase: "invalid", id: "feat-1" }), {
      phase: "invalid",
      id: "feat-1",
      label: "invalid",
    });
  });

  it("includes id on integrating", () => {
    assert.deepEqual(makeStatus({ phase: "integrating", id: "feat-1" }), {
      phase: "integrating",
      id: "feat-1",
      label: "integrating:feat-1",
    });
  });
});
