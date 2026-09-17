import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compareCursors, isEventName, selectEvents } from "./select-events.js";

describe("isEventName", () => {
  it("keeps .json files and rejects everything else", () => {
    assert.equal(isEventName("0001-create.json"), true);
    assert.equal(isEventName("notes.txt"), false);
    assert.equal(isEventName(".hidden.json"), false);
    assert.equal(isEventName("json"), false);
  });
});

describe("compareCursors", () => {
  it("orders byte-wise, not by locale", () => {
    assert.ok(compareCursors("0001.json", "0002.json") < 0);
    assert.ok(compareCursors("Z.json", "a.json") < 0);
    assert.equal(compareCursors("a.json", "a.json"), 0);
  });
});

describe("selectEvents", () => {
  it("sorts by name and drops non-Events", () => {
    const names = ["0003-c.json", "readme.md", "0001-a.json", ".tmp.json", "0002-b.json"];
    assert.deepEqual(selectEvents(names, undefined), ["0001-a.json", "0002-b.json", "0003-c.json"]);
  });

  it("keeps only names strictly greater than the Cursor", () => {
    const names = ["0001-a.json", "0002-b.json", "0003-c.json"];
    assert.deepEqual(selectEvents(names, "0002-b.json"), ["0003-c.json"]);
  });

  it("delivers everything when the Cursor matches no file", () => {
    const names = ["0005-e.json", "0006-f.json"];
    assert.deepEqual(selectEvents(names, "0001-a.json"), ["0005-e.json", "0006-f.json"]);
  });

  it("never delivers a name lower than the Cursor", () => {
    const names = ["0001-late.json", "0009-known.json"];
    assert.deepEqual(selectEvents(names, "0009-known.json"), []);
  });

  it("returns nothing for an empty Source", () => {
    assert.deepEqual(selectEvents([], undefined), []);
  });
});
