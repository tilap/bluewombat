import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkPlan } from "./check-plan.js";

const unit = {
  id: "st-1",
  intention: "Add the CSV serializer",
  definition_of_done: "A unit test writes a CSV matching the fixture",
  depends_on: [] as string[],
};

describe("checkPlan", () => {
  it("accepts a one-Subtask Plan with empty depends_on", () => {
    const result = checkPlan([unit], 10);
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.subtasks.length, 1);
    assert.equal(result.subtasks[0]?.id, "st-1");
  });

  it("renders a numeric id as decimal", () => {
    const result = checkPlan([{ ...unit, id: 2 }], 10);
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.subtasks[0]?.id, "2");
  });

  it("drops duplicate depends_on ids, first occurrence kept", () => {
    const result = checkPlan(
      [
        unit,
        {
          id: "st-2",
          intention: "Wire",
          definition_of_done: "Click",
          depends_on: ["st-1", "st-1"],
        },
      ],
      10,
    );
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.deepEqual(result.subtasks[1]?.depends_on, ["st-1"]);
  });

  it("drops unknown keys on a Subtask", () => {
    const result = checkPlan([{ ...unit, extra: true }], 10);
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.deepEqual(result.subtasks[0], unit);
  });

  it("refuses an empty Plan", () => {
    const result = checkPlan([], 10);
    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.equal(result.code, "empty-plan");
  });

  it("refuses a Plan larger than max-units", () => {
    const result = checkPlan(
      [
        unit,
        { id: "st-2", intention: "b", definition_of_done: "d", depends_on: [] },
        { id: "st-3", intention: "c", definition_of_done: "d", depends_on: [] },
      ],
      2,
    );
    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.equal(result.code, "plan-too-large");
    assert.match(result.reason, /3 Subtasks/);
    assert.match(result.reason, /ceiling of 2/);
  });

  it("refuses a non-object Subtask before missing-id", () => {
    const result = checkPlan(["nope", { intention: "x" }], 10);
    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.equal(result.code, "bad-subtask-shape");
  });

  it("refuses a missing Subtask id", () => {
    const result = checkPlan([{ intention: "x", definition_of_done: "d" }], 10);
    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.equal(result.code, "missing-subtask-id");
  });

  it("refuses duplicate ids", () => {
    const result = checkPlan([unit, { ...unit }], 10);
    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.equal(result.code, "duplicate-id");
  });

  it("refuses a missing Subtask intention", () => {
    const result = checkPlan([{ ...unit, intention: "  " }], 10);
    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.equal(result.code, "missing-subtask-intention");
  });

  it("refuses a missing definition of done", () => {
    const result = checkPlan([{ id: "st-1", intention: "A" }], 10);
    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.equal(result.code, "missing-definition-of-done");
  });

  it("refuses a non-array depends_on", () => {
    const result = checkPlan([{ ...unit, depends_on: "st-1" }], 10);
    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.equal(result.code, "bad-depends-on");
  });

  it("refuses an unknown dependency and names both ids", () => {
    const result = checkPlan([{ ...unit, depends_on: ["st-99"] }], 10);
    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.equal(result.code, "unknown-dependency");
    assert.match(result.reason, /st-99/);
    assert.match(result.reason, /st-1/);
  });

  it("refuses a cycle and names it", () => {
    const result = checkPlan(
      [
        { ...unit, depends_on: ["st-2"] },
        {
          id: "st-2",
          intention: "B",
          definition_of_done: "done B",
          depends_on: ["st-1"],
        },
      ],
      10,
    );
    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.equal(result.code, "cycle");
    assert.match(result.reason, /st-1->st-2->st-1|st-2->st-1->st-2/);
  });

  it("refuses a self-dependency as a cycle", () => {
    const result = checkPlan([{ ...unit, depends_on: ["st-1"] }], 10);
    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.equal(result.code, "cycle");
    assert.match(result.reason, /st-1->st-1/);
  });
});
