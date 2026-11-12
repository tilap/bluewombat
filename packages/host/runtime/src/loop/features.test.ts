import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FeatureAggregate } from "@bluewombat/work-ledger";
import type { HostDeliveryInput } from "./context.js";
import { driveTickets } from "./features.js";

const PROJECT = "proj";
const feature = {
  intention: { key: "feat", project: PROJECT },
  tickets: [],
} as unknown as FeatureAggregate;

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

type Plan = { key: string; blockedBy?: string[]; ms: number; outcome?: "paused" | "refused" };

/**
 * A Conductor that hands out Tickets in order, each only once the Tickets it
 * waits on are done, and records when each one starts and ends.
 */
function fakeInput(plans: Plan[], limit: number) {
  const events: string[] = [];
  const done = new Set<string>();
  const taken = new Set<string>();
  let running = 0;
  let peak = 0;
  const input = {
    options: { ticket: { maxParallel: limit } },
    ledger: {
      list: async () => [],
      get: async () => ({ ok: false }),
      activeTickets: async () => [],
    },
    conductor: {
      reconcile: async () => undefined,
      claimNext: async () => {
        const next = plans.find(
          (plan) => !taken.has(plan.key) && (plan.blockedBy ?? []).every((key) => done.has(key)),
        );
        if (next === undefined) {
          return undefined;
        }
        taken.add(next.key);
        return { key: next.key };
      },
      runTicket: async (key: string) => {
        const plan = plans.find((candidate) => candidate.key === key);
        assert.ok(plan);
        running += 1;
        peak = Math.max(peak, running);
        events.push(`start ${key}`);
        await pause(plan.ms);
        events.push(`end ${key}`);
        running -= 1;
        done.add(key);
        return { outcome: plan.outcome ?? "paused", key };
      },
    },
  } as unknown as HostDeliveryInput;
  return { input, events, peak: () => peak, taken };
}

describe("driveTickets", () => {
  it("starts each Ticket a finished one frees while a place is free", async () => {
    const { input, events, peak } = fakeInput(
      [
        { key: "A", ms: 10 },
        { key: "B", blockedBy: ["A"], ms: 60 },
        { key: "C", blockedBy: ["A"], ms: 60 },
      ],
      2,
    );
    await driveTickets(input, feature, PROJECT, 2);
    assert.ok(events.includes("start C"), `C was never started: ${events.join(", ")}`);
    assert.ok(
      events.indexOf("start C") < events.indexOf("end B"),
      `C waited for B to end: ${events.join(", ")}`,
    );
    assert.equal(peak(), 2);
  });

  it("works one Ticket after the other with a limit of 1", async () => {
    const { input, events, peak } = fakeInput(
      [
        { key: "A", ms: 5 },
        { key: "B", ms: 5 },
        { key: "C", ms: 5 },
      ],
      1,
    );
    await driveTickets(input, feature, PROJECT, 1);
    assert.deepEqual(events, ["start A", "end A", "start B", "end B", "start C", "end C"]);
    assert.equal(peak(), 1);
  });

  it("takes no new Ticket once a run is refused", async () => {
    const { input, taken } = fakeInput(
      [
        { key: "A", ms: 5, outcome: "refused" },
        { key: "B", ms: 40 },
        { key: "C", ms: 5 },
      ],
      2,
    );
    await driveTickets(input, feature, PROJECT, 2);
    assert.deepEqual([...taken].sort(), ["A", "B"]);
  });
});
