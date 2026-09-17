import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hasEventId, readMarkers, renderMarker } from "./marker.js";

describe("renderMarker / readMarkers", () => {
  it("round-trips a record through a comment body", () => {
    const record = { event: "done", key: "github:tilap/mason#42", event_id: "done-42" };
    const body = `## a section\n\n${renderMarker(record)}\n`;
    assert.deepEqual(readMarkers(body), [record]);
  });

  it("finds no record in a body a human wrote", () => {
    assert.deepEqual(readMarkers("Looks good to me. <!-- a plain comment -->"), []);
  });

  it("ignores a marker whose payload is not an object", () => {
    assert.deepEqual(readMarkers("<!-- feature-event not json -->"), []);
    assert.deepEqual(readMarkers("<!-- feature-event [1,2] -->"), []);
  });
});

describe("hasEventId", () => {
  it("recognises an Event already in the Thread", () => {
    const bodies = ["hello", `x ${renderMarker({ event_id: "esc-42-3" })}`];
    assert.equal(hasEventId(bodies, "esc-42-3"), true);
    assert.equal(hasEventId(bodies, "esc-42-4"), false);
    assert.equal(hasEventId([], "esc-42-3"), false);
  });
});
