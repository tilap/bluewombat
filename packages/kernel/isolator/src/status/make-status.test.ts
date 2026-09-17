import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildStatusLabel, makeStatus } from "./make-status.js";

describe("buildStatusLabel", () => {
  it("builds canonical labels", () => {
    assert.equal(buildStatusLabel("isolating", "feat-1"), "isolating:feat-1");
    assert.equal(buildStatusLabel("isolated", "feat-1"), "isolated:feat-1");
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

  it("includes id on isolating", () => {
    assert.deepEqual(makeStatus({ phase: "isolating", id: "feat-1" }), {
      phase: "isolating",
      id: "feat-1",
      label: "isolating:feat-1",
    });
  });
});
