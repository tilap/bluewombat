import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EventFields } from "../types.js";
import { EVENT_NAMES, FIELD_MATRIX, validateFields } from "./field-matrix.js";

function ok(fields: EventFields, event: Parameters<typeof validateFields>[0]): boolean {
  return validateFields(event, fields).ok;
}

describe("validateFields", () => {
  it("accepts each Event with exactly its required fields", () => {
    const minimal: Record<string, EventFields> = {
      invalid: { reason: "no project" },
      accepted: { priority: 75 },
      planned: { plan: "two units" },
      progress: { summary: "Landed 1 of 2: add slugify" },
      escalated: { reason: "refused", stage: "plan" },
      escalation_reminder: { reason: "refused", stage: "plan" },
      resumed: { resume_point: "running" },
      submitted: { reference: "pr-1" },
      done: { reference: "rev-9" },
      cancelled: { state: "running" },
      reject_late: { reason: "already merged" },
    };
    for (const event of EVENT_NAMES) {
      assert.equal(ok(minimal[event] ?? {}, event), true, event);
    }
  });

  it("refuses an Event missing a required field", () => {
    assert.equal(ok({}, "invalid"), false);
    assert.equal(ok({ unit: "u-2", remaining: 1 }, "progress"), false);
    assert.equal(ok({ reason: "x" }, "escalated"), false);
  });

  it("refuses a field the Event does not accept", () => {
    assert.equal(ok({ plan: "p", reference: "rev-9" }, "planned"), false);
    assert.equal(ok({ priority: 50, trace: "t" }, "accepted"), false);
    assert.equal(ok({ reference: "rev-9", state: "merging" }, "done"), false);
  });

  it("names the refused flags in the reason", () => {
    const result = validateFields("planned", { plan: "p", workspace_ref: "w" });
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.reason, /--workspace-ref/);
  });

  it("requires a Trace when the stage is unit", () => {
    assert.equal(ok({ reason: "gate refused", stage: "unit" }, "escalated"), false);
    assert.equal(ok({ reason: "gate refused", stage: "unit", trace: "…" }, "escalated"), true);
  });

  it("does not require a Trace on the other stages", () => {
    for (const stage of ["plan", "integrating", "merging"] as const) {
      assert.equal(ok({ reason: "refused", stage }, "escalated"), true, stage);
    }
  });

  it("accepts remaining 0 as the last unit finishing", () => {
    assert.equal(
      ok({ summary: "Landed 2 of 2: add truncate", unit: "u-9", remaining: 0 }, "progress"),
      true,
    );
  });

  it("covers every Event name in the matrix", () => {
    assert.deepEqual(Object.keys(FIELD_MATRIX).sort(), [...EVENT_NAMES].sort());
  });
});
