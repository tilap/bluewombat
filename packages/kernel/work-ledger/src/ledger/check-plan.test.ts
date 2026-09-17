import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkPlan, initialSubtaskState } from "./check-plan.js";

describe("checkPlan", () => {
  it("refuses an empty Plan", () => {
    assert.equal(checkPlan([]).ok, false);
  });

  it("refuses a missing definition of done", () => {
    assert.equal(
      checkPlan([{ id: "A", intention: "first", definition_of_done: "  ", depends_on: [] }]).ok,
      false,
    );
  });

  it("refuses a cycle", () => {
    assert.equal(
      checkPlan([
        { id: "A", intention: "first", definition_of_done: "A done", depends_on: ["B"] },
        { id: "B", intention: "second", definition_of_done: "B done", depends_on: ["A"] },
      ]).ok,
      false,
    );
  });

  it("refuses a Plan with no root", () => {
    assert.equal(
      checkPlan([{ id: "A", intention: "first", definition_of_done: "A done", depends_on: ["A"] }])
        .ok,
      false,
    );
  });

  it("accepts two Subtasks with B depending on A", () => {
    const checked = checkPlan([
      { id: "A", intention: "first", definition_of_done: "A done", depends_on: [] },
      { id: "B", intention: "second", definition_of_done: "B done", depends_on: ["A"] },
    ]);
    assert.equal(checked.ok, true);
  });
});

describe("initialSubtaskState", () => {
  it("marks a Subtask with no dependencies runnable", () => {
    assert.equal(
      initialSubtaskState({
        id: "A",
        intention: "first",
        definition_of_done: "A done",
        depends_on: [],
      }),
      "runnable",
    );
  });

  it("marks a dependent Subtask pending", () => {
    assert.equal(
      initialSubtaskState({
        id: "B",
        intention: "second",
        definition_of_done: "B done",
        depends_on: ["A"],
      }),
      "pending",
    );
  });
});
