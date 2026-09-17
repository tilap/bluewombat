import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { payloadHasLabel } from "./labels.js";

describe("payloadHasLabel", () => {
  it("reads string labels and object labels, ignoring case", () => {
    assert.equal(payloadHasLabel({ labels: ["Ready"] }, "ready"), true);
    assert.equal(payloadHasLabel({ labels: [{ name: "ready" }] }, "READY"), true);
    assert.equal(payloadHasLabel({ labels: ["bug"] }, "ready"), false);
    assert.equal(payloadHasLabel({}, "ready"), false);
  });
});
