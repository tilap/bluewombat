import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parsePlannerStdout } from "./parse-planner.js";

describe("parsePlannerStdout", () => {
  it("reads a Plan object", () => {
    const parsed = parsePlannerStdout(
      JSON.stringify({
        subtasks: [{ id: "st-1", intention: "i", definition_of_done: "d", depends_on: [] }],
        extra: true,
      }),
    );
    assert.equal(parsed.kind, "plan");
    if (parsed.kind !== "plan") {
      return;
    }
    assert.equal(parsed.subtasks.length, 1);
  });

  it("prefers refusal when both outcome and subtasks are present", () => {
    const parsed = parsePlannerStdout(
      JSON.stringify({
        outcome: "refused",
        code: "not-specifiable",
        reason: "No.",
        subtasks: [{ id: "st-1" }],
      }),
    );
    assert.equal(parsed.kind, "refused");
    if (parsed.kind !== "refused") {
      return;
    }
    assert.equal(parsed.reason, "No.");
  });

  it("stores a missing or other code as not-specifiable via the refused kind", () => {
    const parsed = parsePlannerStdout(JSON.stringify({ outcome: "refused", code: "other" }));
    assert.equal(parsed.kind, "refused");
    if (parsed.kind !== "refused") {
      return;
    }
    assert.equal(parsed.reason, "The Planner refused the FeatureStandard without saying why.");
  });

  it("treats empty, unparseable, or non-object stdout as unusable", () => {
    assert.equal(parsePlannerStdout("").kind, "unusable");
    assert.equal(parsePlannerStdout("nope").kind, "unusable");
    assert.equal(parsePlannerStdout("[]").kind, "unusable");
    assert.equal(parsePlannerStdout("null").kind, "unusable");
    assert.equal(parsePlannerStdout(JSON.stringify({ outcome: "planned" })).kind, "unusable");
  });
});
