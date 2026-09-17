import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkFeatureStandard } from "./check-feature.js";

const maxBytes = 10_000;

describe("checkFeatureStandard", () => {
  it("accepts key, intention, and optional title", () => {
    const result = checkFeatureStandard(
      JSON.stringify({
        key: " fake:42 ",
        intention: " Export CSV ",
        title: " Export ",
        ignored: true,
      }),
      maxBytes,
    );
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.deepEqual(result.feature, {
      key: "fake:42",
      intention: "Export CSV",
      title: "Export",
    });
  });

  it("refuses over --max-feature-bytes before parsing", () => {
    const raw = '{"key":"k"}';
    const result = checkFeatureStandard(raw, Buffer.byteLength(raw, "utf8") - 1);
    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.equal(result.code, "feature-too-large");
  });

  it("refuses unparseable JSON", () => {
    const result = checkFeatureStandard("{", maxBytes);
    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.equal(result.code, "feature-not-json");
  });

  it("refuses a non-object", () => {
    const result = checkFeatureStandard("[]", maxBytes);
    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.equal(result.code, "feature-not-object");
  });

  it("refuses a recognised field of the wrong type before missing-key", () => {
    const result = checkFeatureStandard(JSON.stringify({ key: 42, intention: "i" }), maxBytes);
    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.equal(result.code, "bad-field-type");
  });

  it("refuses missing key", () => {
    const result = checkFeatureStandard(JSON.stringify({ intention: "i" }), maxBytes);
    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.equal(result.code, "missing-key");
    assert.equal(result.key, undefined);
  });

  it("refuses missing intention and keeps the key", () => {
    const result = checkFeatureStandard(JSON.stringify({ key: "fake:42" }), maxBytes);
    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.equal(result.code, "missing-intention");
    assert.equal(result.key, "fake:42");
  });

  it("ignores a field it does not recognise", () => {
    const result = checkFeatureStandard(
      JSON.stringify({ key: "k", intention: "i", acceptance_criteria: ["a"] }),
      maxBytes,
    );
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.deepEqual(result.feature, { key: "k", intention: "i" });
  });
});
