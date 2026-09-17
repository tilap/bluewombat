import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readStdinLimited } from "./read-stdin.js";

async function* chunksOf(parts: string[]): AsyncIterable<string> {
  for (const part of parts) {
    yield part;
  }
}

describe("readStdinLimited", () => {
  it("concatenates chunks under the ceiling", async () => {
    const text = await readStdinLimited(100, chunksOf(["ab", "cd"]));
    assert.equal(text, "abcd");
  });

  it("stops once the document is one byte over the ceiling", async () => {
    const text = await readStdinLimited(3, chunksOf(["abcd", "ef"]));
    assert.equal(Buffer.byteLength(text, "utf8"), 4);
  });
});
