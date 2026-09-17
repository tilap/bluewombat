import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { slugOf } from "./slug.js";

describe("slugOf", () => {
  it("is stable for one key", () => {
    assert.equal(slugOf("fake:42"), slugOf("fake:42"));
  });

  it("keeps the key readable", () => {
    assert.match(slugOf("fake:42"), /^fake-42-[0-9a-f]{8}$/);
  });

  it("separates keys that slug the same", () => {
    assert.notEqual(slugOf("fake:42"), slugOf("fake/42"));
  });

  it("survives a key with nothing sluggable in it", () => {
    assert.match(slugOf(":::"), /^[0-9a-f]{8}$/);
  });

  it("caps the readable part", () => {
    const slug = slugOf("x".repeat(200));
    assert.equal(slug.length, 48 + 1 + 8);
  });

  it("does not leave a separator against the hash", () => {
    assert.doesNotMatch(slugOf("fake:42:"), /--/);
  });
});
