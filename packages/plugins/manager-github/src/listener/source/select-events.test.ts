import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  compareCursors,
  cursorOf,
  formatCursor,
  isPullRequest,
  parseCursor,
  selectEvents,
} from "./select-events.js";

function issue(number: number, updatedAt: string, extra: Record<string, unknown> = {}) {
  return { number, updated_at: updatedAt, title: `#${number}`, ...extra };
}

describe("parseCursor", () => {
  it("reads a timestamp and an issue number", () => {
    assert.deepEqual(parseCursor("2026-09-05T10:00:00Z#42"), {
      updatedAt: "2026-09-05T10:00:00Z",
      number: 42,
    });
  });

  it("refuses anything that is not <updated_at>#<number>", () => {
    assert.equal(parseCursor("2026-09-05T10:00:00Z"), null);
    assert.equal(parseCursor("#42"), null);
    assert.equal(parseCursor("2026-09-05T10:00:00Z#"), null);
    assert.equal(parseCursor("not-a-date#42"), null);
    assert.equal(parseCursor("2026-09-05T10:00:00Z#x"), null);
  });

  it("round-trips what formatCursor writes", () => {
    const cursor = { updatedAt: "2026-09-05T10:00:00Z", number: 7 };
    assert.deepEqual(parseCursor(formatCursor(cursor)), cursor);
  });
});

describe("compareCursors", () => {
  it("orders by timestamp first", () => {
    const early = { updatedAt: "2026-09-05T10:00:00Z", number: 99 };
    const late = { updatedAt: "2026-09-05T11:00:00Z", number: 1 };
    assert.ok(compareCursors(early, late) < 0);
  });

  it("breaks a tie on the number, as a number", () => {
    const nine = { updatedAt: "2026-09-05T10:00:00Z", number: 9 };
    const ten = { updatedAt: "2026-09-05T10:00:00Z", number: 10 };
    assert.ok(compareCursors(nine, ten) < 0);
    assert.equal(compareCursors(nine, nine), 0);
  });
});

describe("cursorOf", () => {
  it("needs an integer number and a readable updated_at", () => {
    assert.deepEqual(cursorOf(issue(42, "2026-09-05T10:00:00Z")), {
      ok: true,
      cursor: { updatedAt: "2026-09-05T10:00:00Z", number: 42 },
    });
    assert.equal(cursorOf({ updated_at: "2026-09-05T10:00:00Z" }).ok, false);
    assert.equal(cursorOf({ number: 42 }).ok, false);
    assert.equal(cursorOf({ number: 42, updated_at: "yesterday" }).ok, false);
  });
});

describe("isPullRequest", () => {
  it("recognises the half of /issues this Block does not subscribe to", () => {
    assert.equal(isPullRequest(issue(1, "2026-09-05T10:00:00Z")), false);
    assert.equal(isPullRequest(issue(1, "2026-09-05T10:00:00Z", { pull_request: {} })), true);
  });
});

describe("selectEvents", () => {
  it("orders Events and drops everything at or before the Cursor", () => {
    const selected = selectEvents(
      [
        issue(3, "2026-09-05T12:00:00Z"),
        issue(1, "2026-09-05T10:00:00Z"),
        issue(2, "2026-09-05T11:00:00Z"),
      ],
      "2026-09-05T10:00:00Z#1",
    );
    assert.deepEqual(
      selected.map((entry) => (entry.kind === "event" ? entry.cursor : entry.reason)),
      ["2026-09-05T11:00:00Z#2", "2026-09-05T12:00:00Z#3"],
    );
  });

  it("delivers from the beginning without a Cursor", () => {
    const selected = selectEvents([issue(1, "2026-09-05T10:00:00Z")], undefined);
    assert.equal(selected.length, 1);
  });

  it("never selects a pull request, and never reports one", () => {
    const selected = selectEvents(
      [issue(1, "2026-09-05T10:00:00Z", { pull_request: { url: "…" } })],
      undefined,
    );
    assert.deepEqual(selected, []);
  });

  it("reports a malformed entry before the Deliveries of the same scan", () => {
    const selected = selectEvents(
      [issue(2, "2026-09-05T11:00:00Z"), "nonsense", { number: 3 }],
      undefined,
    );
    assert.deepEqual(
      selected.map((entry) => entry.kind),
      ["skip", "skip", "event"],
    );
    assert.equal(selected[0]?.kind === "skip" && selected[0].reason, "not-object");
    assert.equal(selected[1]?.kind === "skip" && selected[1].reason, "no-cursor");
  });
});
