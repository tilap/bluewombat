import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canonicalJson, fingerprintOf } from "./fingerprint.js";

describe("canonicalJson", () => {
  it("sorts object keys at every depth", () => {
    assert.equal(
      canonicalJson({ b: 1, a: { d: [3, { f: 1, e: 2 }], c: 2 } }),
      '{"a":{"c":2,"d":[3,{"e":2,"f":1}]},"b":1}',
    );
  });

  it("keeps array order", () => {
    assert.equal(canonicalJson(["b", "a"]), '["b","a"]');
  });
});

describe("fingerprintOf", () => {
  it("ignores key order", () => {
    assert.equal(fingerprintOf({ a: 1, b: 2 }), fingerprintOf({ b: 2, a: 1 }));
  });

  it("ignores fingerprint and normalized_at", () => {
    const base = { key: "fake:1", fingerprint: "", normalized_at: "2026-01-01T00:00:00.000Z" };
    assert.equal(
      fingerprintOf(base),
      fingerprintOf({
        ...base,
        fingerprint: "sha256:x",
        normalized_at: "2030-01-01T00:00:00.000Z",
      }),
    );
  });

  it("changes with any other field", () => {
    assert.notEqual(fingerprintOf({ key: "fake:1" }), fingerprintOf({ key: "fake:2" }));
  });
});
