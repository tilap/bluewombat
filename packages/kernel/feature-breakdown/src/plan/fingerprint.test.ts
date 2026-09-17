import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canonicalPlanJson, fingerprintPlan } from "./fingerprint.js";

const a = {
  id: "st-1",
  intention: "Add the CSV serializer",
  definition_of_done: "A unit test writes a CSV matching the fixture",
  depends_on: [] as string[],
};
const b = {
  id: "st-2",
  intention: "Wire the export button",
  definition_of_done: "Clicking Export downloads the CSV",
  depends_on: ["st-1"],
};

describe("fingerprintPlan", () => {
  it("is stable for the same graph", () => {
    const first = fingerprintPlan("fake:42", [a, b]);
    const second = fingerprintPlan("fake:42", [a, b]);
    assert.equal(first, second);
    assert.match(first, /^sha256:[0-9a-f]{64}$/);
  });

  it("ignores Subtask list order", () => {
    assert.equal(fingerprintPlan("fake:42", [a, b]), fingerprintPlan("fake:42", [b, a]));
  });

  it("ignores depends_on list order", () => {
    const forward = { ...b, depends_on: ["st-1", "st-x"] };
    const reverse = { ...b, depends_on: ["st-x", "st-1"] };
    const extra = { id: "st-x", intention: "x", definition_of_done: "d", depends_on: [] };
    assert.equal(
      fingerprintPlan("fake:42", [a, forward, extra]),
      fingerprintPlan("fake:42", [a, reverse, extra]),
    );
  });

  it("changes when a Subtask intention changes", () => {
    const changed = { ...a, intention: "Add the CSV serializer!" };
    assert.notEqual(fingerprintPlan("fake:42", [a]), fingerprintPlan("fake:42", [changed]));
  });

  it("canonical JSON contains key and sorted subtasks, not planned_at", () => {
    const json = canonicalPlanJson("fake:42", [b, a]);
    const parsed = JSON.parse(json) as { key: string; subtasks: { id: string }[] };
    assert.equal(parsed.key, "fake:42");
    assert.deepEqual(
      parsed.subtasks.map((st) => st.id),
      ["st-1", "st-2"],
    );
    assert.equal(json.includes("planned_at"), false);
  });
});
