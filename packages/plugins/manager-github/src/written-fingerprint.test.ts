import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { writtenFingerprint } from "./written-fingerprint.js";

const issue = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  number: 1,
  title: "Add slugify",
  body: "A slug helper.",
  state: "open",
  labels: [{ name: "mason" }],
  updated_at: "2026-09-11T19:58:00Z",
  comments: 0,
  ...over,
});

describe("writtenFingerprint", () => {
  it("does not move when the manager itself writes to the issue", () => {
    const before = writtenFingerprint(issue(), "mason:");
    const after = writtenFingerprint(
      issue({
        updated_at: "2026-09-11T19:59:00Z",
        comments: 3,
        labels: [{ name: "mason:invalid" }, { name: "mason" }],
      }),
      "mason:",
    );
    assert.equal(after, before);
  });

  it("moves when a human edits the title, the body, a label of theirs, or closes it", () => {
    const base = writtenFingerprint(issue(), "mason:");
    assert.notEqual(writtenFingerprint(issue({ title: "Add slugify()" }), "mason:"), base);
    assert.notEqual(writtenFingerprint(issue({ body: "A different intention." }), "mason:"), base);
    assert.notEqual(
      writtenFingerprint(issue({ labels: [{ name: "mason" }, { name: "priority:10" }] }), "mason:"),
      base,
    );
    assert.notEqual(writtenFingerprint(issue({ state: "closed" }), "mason:"), base);
  });

  it("counts every label when no state prefix is configured", () => {
    const base = writtenFingerprint(issue(), undefined);
    assert.notEqual(
      writtenFingerprint(
        issue({ labels: [{ name: "mason" }, { name: "mason:invalid" }] }),
        undefined,
      ),
      base,
    );
  });
});
