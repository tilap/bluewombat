import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildStatusLabel, makeStatus } from "./make-status.js";

describe("buildStatusLabel", () => {
  it("builds canonical labels", () => {
    assert.equal(buildStatusLabel("planning", "fake:42"), "planning:fake:42");
    assert.equal(buildStatusLabel("planned", "fake:42"), "planned:fake:42");
    assert.equal(buildStatusLabel("refused", "fake:42"), "refused:fake:42");
    assert.equal(buildStatusLabel("unavailable", "fake:42"), "unavailable:fake:42");
    assert.equal(buildStatusLabel("interrupted", "fake:42"), "interrupted:fake:42");
    assert.equal(buildStatusLabel("invalid", undefined), "invalid");
    assert.equal(buildStatusLabel("refused", undefined), "refused");
  });
});

describe("makeStatus", () => {
  it("omits key when unusable", () => {
    assert.deepEqual(makeStatus({ phase: "invalid" }), {
      phase: "invalid",
      label: "invalid",
    });
    assert.deepEqual(makeStatus({ phase: "refused" }), {
      phase: "refused",
      label: "refused",
    });
  });

  it("includes key when usable", () => {
    assert.deepEqual(makeStatus({ phase: "planning", key: "fake:42" }), {
      phase: "planning",
      key: "fake:42",
      label: "planning:fake:42",
    });
  });
});
