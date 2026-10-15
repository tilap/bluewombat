import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EVENT_NAMES } from "@bluewombat/manager-kit";
import { isStateLabel, resolveStateLabels, stateLabelOf } from "./state-labels.js";

const every = (label: (event: string) => string): Record<string, string> =>
  Object.fromEntries(EVENT_NAMES.map((event) => [event, label(event)]));

describe("resolveStateLabels", () => {
  it("leaves the Events without a label when nothing names them", () => {
    assert.deepEqual(resolveStateLabels(undefined), { ok: true, labels: undefined });
  });

  it("gives each Event the label it is named with", () => {
    const resolved = resolveStateLabels(every((event) => `s-${event}`));
    assert.equal(resolved.ok, true);
    if (resolved.ok && resolved.labels !== undefined) {
      assert.equal(stateLabelOf(resolved.labels, "cancelled"), "s-cancelled");
      assert.equal(stateLabelOf(resolved.labels, "escalation_reminder"), "s-escalation_reminder");
      assert.equal(stateLabelOf(resolved.labels, "planned"), undefined);
    }
  });

  it("names the Events it is missing", () => {
    const resolved = resolveStateLabels({ done: "termine" });
    assert.equal(resolved.ok, false);
    assert.match(
      resolved.ok ? "" : resolved.reason,
      /must name every event; missing: invalid, accepted/,
    );
  });

  it("refuses a name that is not an Event, and two Events sharing a label", () => {
    const unknown = resolveStateLabels({ ...every((event) => event), planned: "x" });
    assert.equal(unknown.ok, false);
    assert.match(unknown.ok ? "" : unknown.reason, /"planned".*not an event/);
    const twice = resolveStateLabels({
      ...every((event) => event),
      done: "Same",
      cancelled: "same",
    });
    assert.equal(twice.ok, false);
    assert.match(twice.ok ? "" : twice.reason, /both done and cancelled/);
  });
});

describe("isStateLabel", () => {
  it("knows exactly the named labels, whatever their case", () => {
    const resolved = resolveStateLabels({ ...every((event) => `s-${event}`), done: "Termine" });
    assert.equal(resolved.ok, true);
    if (resolved.ok && resolved.labels !== undefined) {
      assert.equal(isStateLabel(resolved.labels, "termine"), true);
      assert.equal(isStateLabel(resolved.labels, "S-ACCEPTED"), true);
      assert.equal(isStateLabel(resolved.labels, "s-anything"), false);
      assert.equal(isStateLabel(resolved.labels, "project:app"), false);
    }
  });
});
