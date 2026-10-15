import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EVENT_NAMES } from "@bluewombat/manager-kit";
import { resolveStateLabels } from "./state-labels.js";
import { writtenFingerprint } from "./written-fingerprint.js";

function labelsOf(over: Record<string, string> = {}) {
  const resolved = resolveStateLabels({
    ...Object.fromEntries(EVENT_NAMES.map((event) => [event, `mason:${event}`])),
    ...over,
  });
  if (!resolved.ok || resolved.labels === undefined) {
    throw new Error("state labels expected");
  }
  return resolved.labels;
}

const MASON = labelsOf();

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
    const before = writtenFingerprint(issue(), MASON);
    const after = writtenFingerprint(
      issue({
        updated_at: "2026-09-11T19:59:00Z",
        comments: 3,
        labels: [{ name: "mason:invalid" }, { name: "mason" }],
      }),
      MASON,
    );
    assert.equal(after, before);
  });

  it("moves when a human edits the title, the body, a label of theirs, or closes it", () => {
    const base = writtenFingerprint(issue(), MASON);
    assert.notEqual(writtenFingerprint(issue({ title: "Add slugify()" }), MASON), base);
    assert.notEqual(writtenFingerprint(issue({ body: "A different intention." }), MASON), base);
    assert.notEqual(
      writtenFingerprint(issue({ labels: [{ name: "mason" }, { name: "priority:10" }] }), MASON),
      base,
    );
    assert.notEqual(writtenFingerprint(issue({ state: "closed" }), MASON), base);
  });

  it("leaves out the labels the configuration chose for the states", () => {
    const own = labelsOf({
      invalid: "s-invalid",
      accepted: "s-accepted",
      progress: "s-progress",
      escalated: "s-escalated",
      escalation_reminder: "s-reminder",
      resumed: "s-resumed",
      submitted: "s-submitted",
      done: "s-done",
      cancelled: "s-cancelled",
      reject_late: "s-late",
    });
    const before = writtenFingerprint(issue(), own);
    const after = writtenFingerprint(
      issue({ labels: [{ name: "mason" }, { name: "s-done" }] }),
      own,
    );
    assert.equal(after, before);
    assert.notEqual(
      writtenFingerprint(issue({ labels: [{ name: "mason" }, { name: "mason:done" }] }), own),
      before,
    );
  });

  it("counts every label when no state label is configured", () => {
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
