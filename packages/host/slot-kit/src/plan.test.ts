import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkPlan } from "./plan.js";

function subtask(id: string, dependsOn: string[] = []): Record<string, unknown> {
  return {
    id,
    intention: `do ${id}`,
    definition_of_done: `${id} is done`,
    depends_on: dependsOn,
  };
}

function reasonOf(result: ReturnType<typeof checkPlan>): string {
  assert.ok(!result.ok);
  return result.reason;
}

describe("checkPlan", () => {
  it("accepts a chain", () => {
    assert.deepEqual(checkPlan([subtask("a"), subtask("b", ["a"])]), {
      ok: true,
      subtasks: [subtask("a"), subtask("b", ["a"])],
    });
  });

  it("refuses anything that is not a non-empty array", () => {
    assert.equal(reasonOf(checkPlan([])), "The plan has no subtasks.");
    assert.equal(reasonOf(checkPlan(undefined)), "The plan has no subtasks.");
    assert.equal(reasonOf(checkPlan({ subtasks: [] })), "The plan has no subtasks.");
  });

  it("refuses a plan over the allowed size", () => {
    const plan = [subtask("a"), subtask("b"), subtask("c")];
    assert.equal(reasonOf(checkPlan(plan, 2)), "The plan has 3 subtasks, over the 2 allowed.");
    assert.deepEqual(checkPlan(plan, 3), { ok: true, subtasks: plan });
  });

  it("ignores a size that is not an integer", () => {
    assert.deepEqual(checkPlan([subtask("a")], Number.NaN), { ok: true, subtasks: [subtask("a")] });
    assert.deepEqual(checkPlan([subtask("a")]), { ok: true, subtasks: [subtask("a")] });
  });

  it("refuses an entry that is not an object", () => {
    assert.equal(reasonOf(checkPlan(["a"])), "A subtask is not an object.");
    assert.equal(reasonOf(checkPlan([null])), "A subtask is not an object.");
  });

  it("names the field a subtask is missing", () => {
    assert.equal(reasonOf(checkPlan([{ ...subtask("a"), id: "  " }])), 'A subtask has no "id".');
    assert.equal(
      reasonOf(checkPlan([{ ...subtask("a"), intention: "" }])),
      'A subtask has no "intention".',
    );
    const shapeless = { ...subtask("a") };
    delete shapeless.definition_of_done;
    assert.equal(reasonOf(checkPlan([shapeless])), 'A subtask has no "definition_of_done".');
  });

  it("refuses two subtasks sharing an id", () => {
    assert.equal(
      reasonOf(checkPlan([subtask("a"), subtask("a")])),
      'Two subtasks share the id "a".',
    );
  });

  it("refuses a missing depends_on list", () => {
    const loose = { ...subtask("a") };
    delete loose.depends_on;
    assert.equal(reasonOf(checkPlan([loose])), 'Subtask "a" has no depends_on list.');
  });

  it("refuses a dependency on itself", () => {
    assert.equal(reasonOf(checkPlan([subtask("a", ["a"])])), 'Subtask "a" depends on itself.');
  });

  it("refuses a dependency that is not in the plan", () => {
    assert.equal(
      reasonOf(checkPlan([subtask("a", ["ghost"])])),
      'Subtask "a" depends on "ghost", which is not in the plan.',
    );
  });

  it("names the loop it found", () => {
    const plan = [subtask("a", ["c"]), subtask("b", ["a"]), subtask("c", ["b"])];
    assert.equal(reasonOf(checkPlan(plan)), "The plan has a cycle: a → c → b → a.");
  });

  it("accepts a diamond, which is not a cycle", () => {
    const plan = [subtask("a"), subtask("b", ["a"]), subtask("c", ["a"]), subtask("d", ["b", "c"])];
    assert.deepEqual(checkPlan(plan), { ok: true, subtasks: plan });
  });
});
