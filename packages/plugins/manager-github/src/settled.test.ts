import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EVENT_NAMES } from "@bluewombat/manager-kit";
import { settledAlready } from "./settled.js";
import { resolveStateLabels } from "./state-labels.js";

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

describe("settledAlready", () => {
  it("skips an issue the tracker says is done or cancelled", () => {
    assert.equal(settledAlready({ labels: ["mason", "mason:done"] }, MASON, "to-resume"), true);
    // A wiped ledger took up an abandoned issue again and started planning it.
    assert.equal(
      settledAlready({ labels: ["mason", "mason:cancelled"] }, MASON, "to-resume"),
      true,
    );
  });

  it("still delivers what is resumed, or not settled", () => {
    assert.equal(
      settledAlready({ labels: ["mason", "mason:cancelled", "to-resume"] }, MASON, "to-resume"),
      false,
    );
    assert.equal(
      settledAlready({ labels: ["mason", "mason:escalated"] }, MASON, "to-resume"),
      false,
    );
    assert.equal(settledAlready({ labels: ["mason", "to-resume"] }, MASON, "to-resume"), false);
  });

  it("reads the labels the configuration chose for done and cancelled", () => {
    const own = labelsOf({ done: "termine", cancelled: "abandonne" });
    assert.equal(settledAlready({ labels: ["termine"] }, own, "to-resume"), true);
    assert.equal(settledAlready({ labels: ["abandonne"] }, own, "to-resume"), true);
    assert.equal(settledAlready({ labels: ["mason:done"] }, own, "to-resume"), false);
  });
});
