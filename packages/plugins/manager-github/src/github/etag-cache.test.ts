import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createEtagCache } from "./etag-cache.js";

describe("createEtagCache", () => {
  it("lets the least recently used answer go first", () => {
    const cache = createEtagCache(2);
    cache.set("a", { etag: "1", response: "A" });
    cache.set("b", { etag: "2", response: "B" });
    cache.get("a");
    cache.set("c", { etag: "3", response: "C" });
    assert.equal(cache.get("b"), undefined);
    assert.equal(cache.get("a")?.response, "A");
    assert.equal(cache.get("c")?.response, "C");
  });
});
