import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hasLabel, readLabels, valuesWithPrefix } from "./labels.js";

describe("readLabels", () => {
  it("reads the objects GitHub writes and the strings a caller types", () => {
    assert.deepEqual(readLabels({ labels: [{ name: "mason" }, "ready"] }), {
      ok: true,
      names: ["mason", "ready"],
    });
  });

  it("treats an absent or null labels field as no label", () => {
    assert.deepEqual(readLabels({}), { ok: true, names: [] });
    assert.deepEqual(readLabels({ labels: null }), { ok: true, names: [] });
  });

  it("refuses a labels field it cannot read", () => {
    assert.equal(readLabels({ labels: "ready" }).ok, false);
    assert.equal(readLabels({ labels: [{ colour: "red" }] }).ok, false);
  });
});

describe("valuesWithPrefix", () => {
  it("returns what the prefixed labels say, prefix removed", () => {
    assert.deepEqual(valuesWithPrefix(["project:reporting", "mason"], "project:"), ["reporting"]);
  });

  it("matches the prefix whatever its case, and drops an empty value", () => {
    assert.deepEqual(valuesWithPrefix(["Project: reporting", "project:"], "project:"), [
      "reporting",
    ]);
  });
});

describe("hasLabel", () => {
  it("compares label names without case", () => {
    assert.equal(hasLabel(["Ready"], "ready"), true);
    assert.equal(hasLabel(["readyish"], "ready"), false);
  });
});
