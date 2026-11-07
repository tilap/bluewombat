import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { finished, observe, type Snapshot } from "./observe.js";

const limits = { stallAfterMs: 10 * 60_000, diskMinBytes: 3 * 1024 ** 3, settleMs: 0 };
const GIB = 1024 ** 3;

function snap(extra: Partial<Snapshot> = {}): Snapshot {
  return { now: 2_000_000_000_000, items: [], canStartWorker: true, workerPid: 42, ...extra };
}

describe("observe", () => {
  it("finds nothing wrong in a healthy run", () => {
    assert.deepEqual(
      observe(
        snap({
          items: [{ key: "k#1", scope: "ticket", state: "running" }],
          journalAt: 2_000_000_000_000 - 60_000,
          freeBytes: 50 * GIB,
        }),
        limits,
      ),
      [],
    );
  });

  it("calls a missing worker a finding only when the supervisor can start one", () => {
    const missing = snap({ workerPid: undefined as unknown as number });
    delete (missing as { workerPid?: number }).workerPid;
    assert.equal(observe(missing, limits)[0]?.kind, "worker-down");
    assert.deepEqual(observe({ ...missing, canStartWorker: false }, limits), []);
  });

  it("finds a stall: a silent journal with work active", () => {
    const found = observe(
      snap({
        items: [{ key: "k#1", scope: "ticket", state: "integrating" }],
        journalAt: 2_000_000_000_000 - 30 * 60_000,
      }),
      limits,
    );
    assert.equal(found[0]?.kind, "stalled");
    assert.equal(found[0]?.key, "k#1");
  });

  it("does not call idleness a stall when nothing is active", () => {
    const found = observe(
      snap({
        items: [{ key: "k#1", scope: "ticket", state: "done" }],
        journalAt: 2_000_000_000_000 - 3 * 60 * 60_000,
      }),
      limits,
    );
    assert.deepEqual(found, []);
  });

  it("finds low disk", () => {
    assert.equal(observe(snap({ freeBytes: 2 * GIB }), limits)[0]?.kind, "disk-low");
  });

  it("finds an escalation and tells a changed one from the same one", () => {
    const at = (report: string) =>
      observe(
        snap({
          items: [
            { key: "k#1", scope: "ticket", state: "escalated", escalation: { report, at: 5 } },
          ],
        }),
        limits,
      )[0];
    assert.equal(at("gate blocked")?.kind, "escalated");
    assert.equal(at("gate blocked")?.fingerprint, at("gate blocked")?.fingerprint);
    assert.notEqual(at("gate blocked")?.fingerprint, at("merge conflict")?.fingerprint);
  });

  it("leaves a young escalation to the person who may be on it", () => {
    const now = 2_000_000_000_000;
    const young = snap({
      now,
      items: [
        {
          key: "k#1",
          scope: "ticket",
          state: "escalated",
          escalation: { report: "x", at: now - 1000 },
        },
      ],
    });
    assert.deepEqual(observe(young, { ...limits, settleMs: 60_000 }), []);
    assert.equal(observe(young, limits).length, 1);
  });

  it("lists the keys that ended", () => {
    assert.deepEqual(
      finished([
        { key: "a", scope: "ticket", state: "done" },
        { key: "b", scope: "ticket", state: "escalated" },
        { key: "c", scope: "feature", state: "cancelled" },
      ]),
      ["a", "c"],
    );
  });
});
