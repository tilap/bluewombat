import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { openFilesystemPersist } from "@bluewombat/persist-fs";
import { openWorkLedger, type WorkLedger } from "@bluewombat/work-ledger";
import type { HostDeliveryInput } from "./context.js";
import { handleCancel, handleResume } from "./deliveries.js";

// A resume is a human's decision, not a claim: it must not take a place the Project does not have.

const PROJECT = "proj";

async function escalatedPair(): Promise<WorkLedger> {
  const ledger = openWorkLedger({
    persist: await openFilesystemPersist({ root: mkdtempSync(join(tmpdir(), "resume-")) }),
  });
  for (const key of ["fake:1", "fake:2"]) {
    await ledger.admit({
      key,
      project: PROJECT,
      fingerprint: `fp-${key}`,
      priority: 1,
      intention: "do the thing",
    });
    assert.equal((await ledger.claim(PROJECT, 2)).ok, true);
    assert.equal((await ledger.escalate({ key, kind: "assembly" })).ok, true);
  }
  return ledger;
}

function inputFor(ledger: WorkLedger, maxParallel?: number) {
  const cleared: string[] = [];
  const traced: string[] = [];
  const input = {
    options: { ticket: maxParallel === undefined ? {} : { maxParallel } },
    ledger,
    tickets: {
      report: async () => true,
      clearResume: async (key: string) => {
        cleared.push(key);
      },
    },
    journal: { append: () => undefined },
    reported: [],
    said: new Set<string>(),
    trace: (line: string) => {
      traced.push(line);
    },
  } as unknown as HostDeliveryInput;
  return { input, cleared, traced };
}

async function stateOf(ledger: WorkLedger, key: string): Promise<string | undefined> {
  const got = await ledger.get(key);
  return got.ok ? got.aggregate.state : undefined;
}

describe("handleResume", () => {
  it("resumes one Ticket and keeps the next one waiting while the limit is reached", async () => {
    const ledger = await escalatedPair();
    const { input, cleared, traced } = inputFor(ledger);

    await handleResume({ key: "fake:1", project: PROJECT }, input);
    await handleResume({ key: "fake:2", project: PROJECT }, input);

    assert.equal(await stateOf(ledger, "fake:1"), "integrating");
    assert.equal(await stateOf(ledger, "fake:2"), "escalated");
    assert.deepEqual(cleared, ["fake:1"], "the waiting Ticket keeps its signal");
    assert.equal(traced.length, 1);
    assert.match(traced[0] ?? "", /fake:2 waits/);
  });

  it("resumes the waiting Ticket once the other one is no longer worked on", async () => {
    const ledger = await escalatedPair();
    const { input, cleared } = inputFor(ledger);
    await handleResume({ key: "fake:1", project: PROJECT }, input);
    await handleResume({ key: "fake:2", project: PROJECT }, input);

    assert.equal((await ledger.escalate({ key: "fake:1", kind: "assembly" })).ok, true);
    await handleResume({ key: "fake:2", project: PROJECT }, input);

    assert.equal(await stateOf(ledger, "fake:2"), "integrating");
    assert.deepEqual(cleared, ["fake:1", "fake:2"]);
  });

  it("resumes both when the Project works on two Tickets at once", async () => {
    const ledger = await escalatedPair();
    const { input } = inputFor(ledger, 2);
    await handleResume({ key: "fake:1", project: PROJECT }, input);
    await handleResume({ key: "fake:2", project: PROJECT }, input);

    assert.equal(await stateOf(ledger, "fake:1"), "integrating");
    assert.equal(await stateOf(ledger, "fake:2"), "integrating");
  });
});

describe("handleCancel", () => {
  function cancelInput(aggregate: Record<string, unknown>, withdrawn: string[], reports: string[]) {
    return {
      ledger: { get: async () => ({ ok: true, aggregate }) },
      conductor: { cancel: async () => ({ ok: true }) },
      tickets: {
        report: async (report: { event: string }) => {
          reports.push(report.event);
          return true;
        },
        withdraw: async (input: { id: string }) => {
          withdrawn.push(input.id);
        },
      },
      journal: { append: () => undefined },
      reported: [],
      said: new Set<string>(),
    } as unknown as HostDeliveryInput;
  }

  it("withdraws the Submission of an abandoned Ticket, then says it was cancelled", async () => {
    const withdrawn: string[] = [];
    const reports: string[] = [];
    const input = cancelInput(
      { state: "submitted", submission: { id: "7", reference: "https://example.test/pr/1" } },
      withdrawn,
      reports,
    );
    await handleCancel({ key: "fake:1", project: PROJECT }, input);
    assert.deepEqual(withdrawn, ["7"]);
    assert.deepEqual(reports, ["cancelled"]);
  });

  it("withdraws nothing from a Ticket that has no Submission", async () => {
    const withdrawn: string[] = [];
    const reports: string[] = [];
    const input = cancelInput({ state: "running" }, withdrawn, reports);
    await handleCancel({ key: "fake:1", project: PROJECT }, input);
    assert.deepEqual(withdrawn, []);
    assert.deepEqual(reports, ["cancelled"]);
  });
});
