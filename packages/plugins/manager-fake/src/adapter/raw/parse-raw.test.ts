import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseRaw } from "./parse-raw.js";

describe("parseRaw", () => {
  it("accepts a JSON object within the ceiling", () => {
    const result = parseRaw('{"id":"42"}', 1_000);
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok && result.object, { id: "42" });
  });

  it("refuses a raw intention over --max-raw-bytes", () => {
    const result = parseRaw('{"id":"42"}', 5);
    assert.equal(result.ok === false && result.invalid.code, "raw-too-large");
  });

  it("counts bytes, not characters", () => {
    // "é" is two bytes in UTF-8, so this is 13 bytes for 12 characters.
    const raw = '{"id":"éé"}';
    assert.equal(parseRaw(raw, Buffer.byteLength(raw, "utf8")).ok, true);
    assert.equal(parseRaw(raw, Buffer.byteLength(raw, "utf8") - 1).ok, false);
  });

  it("refuses what is not JSON", () => {
    const result = parseRaw("not json", 1_000);
    assert.equal(result.ok === false && result.invalid.code, "raw-not-json");
  });

  it("refuses JSON that is not an object", () => {
    for (const raw of ["[1,2]", '"text"', "7", "null"]) {
      const result = parseRaw(raw, 1_000);
      assert.equal(result.ok === false && result.invalid.code, "raw-not-object", raw);
    }
  });
});
