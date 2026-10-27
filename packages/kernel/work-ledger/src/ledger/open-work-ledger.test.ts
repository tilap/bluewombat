import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PersistencePort } from "../persist/port.js";
import type { Aggregate, FeatureAggregate, Summary, TicketAggregate } from "../records.js";
import { isFeatureAggregate } from "../records.js";
import { openWorkLedger, type TicketAdmission, type WorkLedger } from "./open-work-ledger.js";

function toSummary(aggregate: Aggregate): Summary {
  if (isFeatureAggregate(aggregate)) {
    return {
      kind: "feature",
      key: aggregate.intention.key,
      project: aggregate.intention.project,
      state: aggregate.state,
      priority: aggregate.intention.priority,
      received_at: aggregate.received_at,
    };
  }
  const summary: Summary = {
    key: aggregate.intention.key,
    project: aggregate.intention.project,
    state: aggregate.state,
    priority: aggregate.intention.priority,
    received_at: aggregate.received_at,
  };
  if (aggregate.bail !== undefined) {
    summary.bail_expires_at = aggregate.bail.expires_at;
  }
  if (aggregate.intention.feature !== undefined) {
    summary.feature = aggregate.intention.feature;
  }
  return summary;
}

/** Test-double Persistence Port. Lives in this test file, not as a shipping adapter. */
function openMemoryPersist(): PersistencePort {
  const store = new Map<string, Aggregate>();
  return {
    async load(key) {
      const found = store.get(key);
      return found === undefined ? undefined : structuredClone(found);
    },
    async save(key, aggregate) {
      store.set(key, structuredClone(aggregate));
      return { ok: true };
    },
    async listSummaries() {
      return [...store.values()].map(toSummary);
    },
  };
}

function ticket(over: Partial<TicketAdmission> = {}): TicketAdmission {
  return {
    key: "fake:42",
    project: "proj",
    fingerprint: "fp-1",
    priority: 1,
    intention: "do the thing",
    ...over,
  };
}

/** Claim, run and finish the unit: the Ticket is `integrating`. */
async function toIntegrating(ledger: WorkLedger): Promise<void> {
  await ledger.admit(ticket());
  await claimKey(ledger, "proj");
  await ledger.recordAttempt({ key: "fake:42", number: 1, trace: { ended: "validated" } });
  await ledger.markIntegrating("fake:42");
}

function ledgerAt(nowMs: { value: number }): WorkLedger {
  return openWorkLedger({
    persist: openMemoryPersist(),
    now: () => nowMs.value,
    bailDurationMs: 1_000,
  });
}

async function requireAggregate(ledger: WorkLedger, key: string): Promise<TicketAggregate> {
  const got = await ledger.get(key);
  assert.equal(got.ok, true);
  if (!got.ok) {
    throw new Error("unreachable");
  }
  return got.aggregate;
}

async function claimKey(ledger: WorkLedger, project: string): Promise<string> {
  const claimed = await ledger.claim(project);
  assert.equal(claimed.ok, true);
  assert.equal("key" in claimed, true);
  if (!claimed.ok || !("key" in claimed)) {
    throw new Error("unreachable");
  }
  return claimed.key;
}

describe("openWorkLedger (test-double Port)", () => {
  it("1. admit of a new TicketStandard is received with that key and fingerprint", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    const admitted = await ledger.admit(ticket());
    assert.deepEqual(admitted, { ok: true });
    const aggregate = await requireAggregate(ledger, "fake:42");
    assert.equal(aggregate.state, "received");
    assert.equal(aggregate.intention.key, "fake:42");
    assert.equal(aggregate.intention.fingerprint, "fp-1");
    assert.equal(aggregate.resumes, 0);
  });

  it("2. admit of the same key and fingerprint is success with no rewrite", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admit(ticket());
    const first = await requireAggregate(ledger, "fake:42");
    const admitted = await ledger.admit(ticket());
    assert.deepEqual(admitted, { ok: true });
    const second = await requireAggregate(ledger, "fake:42");
    assert.equal(second.intention.fingerprint, first.intention.fingerprint);
    assert.equal(second.intention.intention, first.intention.intention);
    assert.equal(second.received_at, first.received_at);
  });

  it("3. admit of the same key with a new fingerprint while received updates the intention", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admit(ticket());
    const admitted = await ledger.admit(
      ticket({ fingerprint: "fp-2", intention: "do it differently" }),
    );
    assert.deepEqual(admitted, { ok: true });
    const aggregate = await requireAggregate(ledger, "fake:42");
    assert.equal(aggregate.state, "received");
    assert.equal(aggregate.intention.fingerprint, "fp-2");
    assert.equal(aggregate.intention.intention, "do it differently");
  });

  it("4. admit while running sets pending fingerprint and leaves the state", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admit(ticket());
    await claimKey(ledger, "proj");
    const admitted = await ledger.admit(ticket({ fingerprint: "fp-2" }));
    assert.deepEqual(admitted, { ok: true });
    const after = await requireAggregate(ledger, "fake:42");
    assert.equal(after.state, "running");
    assert.equal(after.pending_fingerprint, "fp-2");
    assert.equal(after.intention.fingerprint, "fp-1");
  });

  it("4b. admit of the same fingerprint while in flight leaves the record unchanged", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admit(ticket());
    await claimKey(ledger, "proj");
    const before = await requireAggregate(ledger, "fake:42");
    const admitted = await ledger.admit(ticket());
    assert.deepEqual(admitted, { ok: true });
    const after = await requireAggregate(ledger, "fake:42");
    assert.equal(after.pending_fingerprint, undefined);
    assert.deepEqual(after, before);
  });

  it("4c. admit of the same fingerprint while submitted leaves the record unchanged", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await toIntegrating(ledger);
    await ledger.markSubmitted({ key: "fake:42", reference: "ref-1" });
    const before = await requireAggregate(ledger, "fake:42");
    assert.equal(before.state, "submitted");

    const echo = await ledger.admit(ticket());
    assert.deepEqual(echo, { ok: true });
    const afterEcho = await requireAggregate(ledger, "fake:42");
    assert.equal(afterEcho.pending_fingerprint, undefined);
    assert.deepEqual(afterEcho, before);

    const edited = await ledger.admit(ticket({ fingerprint: "fp-2" }));
    assert.deepEqual(edited, { ok: true });
    const afterEdit = await requireAggregate(ledger, "fake:42");
    assert.equal(afterEdit.state, "submitted");
    assert.equal(afterEdit.pending_fingerprint, "fp-2");
    assert.equal(afterEdit.intention.fingerprint, "fp-1");

    const echoOfEdit = await ledger.admit(ticket({ fingerprint: "fp-2" }));
    assert.deepEqual(echoOfEdit, { ok: true });
    const afterEchoOfEdit = await requireAggregate(ledger, "fake:42");
    assert.deepEqual(afterEchoOfEdit, afterEdit);
  });

  it("5. claim takes the received Ticket then a second claim is project-busy", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admit(ticket());
    const claimed = await ledger.claim("proj");
    assert.deepEqual(claimed, { ok: true, key: "fake:42" });
    const aggregate = await requireAggregate(ledger, "fake:42");
    assert.equal(aggregate.state, "running");
    assert.equal(aggregate.bail, undefined);
    const second = await ledger.claim("proj");
    assert.deepEqual(second, { ok: false, code: "project-busy" });
  });

  it("5b. startUnit takes the lease once and refuses a unit already held", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admit(ticket());
    assert.deepEqual(await ledger.startUnit("fake:42"), { ok: false, code: "illegal-transition" });
    await claimKey(ledger, "proj");
    assert.deepEqual(await ledger.startUnit("fake:42"), { ok: true });
    assert.equal((await requireAggregate(ledger, "fake:42")).bail?.expires_at, 2_000);
    assert.deepEqual(await ledger.startUnit("fake:42"), { ok: false, code: "another-running" });
  });

  it("6. recordAttempt numbers the Attempts from 1 and refuses a gap", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admit(ticket());
    await claimKey(ledger, "proj");
    assert.deepEqual(await ledger.recordAttempt({ key: "fake:42", number: 2 }), {
      ok: false,
      code: "illegal-transition",
    });
    assert.deepEqual(await ledger.recordAttempt({ key: "fake:42", number: 1 }), { ok: true });
    assert.deepEqual(await ledger.recordAttempt({ key: "fake:42", number: 2 }), { ok: true });
    const aggregate = await requireAggregate(ledger, "fake:42");
    assert.equal(aggregate.attempts.length, 2);
    assert.equal(aggregate.attempts_used, 2);
  });

  it("7. recordAttempt is refused while the Ticket is not running", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admit(ticket());
    assert.deepEqual(await ledger.recordAttempt({ key: "fake:42", number: 1 }), {
      ok: false,
      code: "illegal-transition",
    });
  });

  it("8. markIntegrating moves a running Ticket to integrating and is refused otherwise", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admit(ticket());
    assert.deepEqual(await ledger.markIntegrating("fake:42"), {
      ok: false,
      code: "illegal-transition",
    });
    await claimKey(ledger, "proj");
    assert.deepEqual(await ledger.markIntegrating("fake:42"), { ok: true });
    assert.equal((await requireAggregate(ledger, "fake:42")).state, "integrating");
  });

  it("9. cancel in merging is point-of-no-return and leaves merging", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await toIntegrating(ledger);
    await ledger.markMerging("fake:42");
    const cancelled = await ledger.cancel("fake:42");
    assert.deepEqual(cancelled, { ok: false, code: "point-of-no-return" });
    const aggregate = await requireAggregate(ledger, "fake:42");
    assert.equal(aggregate.state, "merging");
  });

  it("10. escalate after recordAttempt without a Trace is missing-trace", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admit(ticket());
    await claimKey(ledger, "proj");
    const recorded = await ledger.recordAttempt({ key: "fake:42", number: 1 });
    assert.deepEqual(recorded, { ok: true });
    const escalated = await ledger.escalate({ key: "fake:42", kind: "unit" });
    assert.deepEqual(escalated, { ok: false, code: "missing-trace" });
    const aggregate = await requireAggregate(ledger, "fake:42");
    assert.equal(aggregate.state, "running");
  });

  it("10b. resumeTicket counts the rounds, so two escalations of one kind can be told apart", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admit(ticket());
    await claimKey(ledger, "proj");
    assert.equal((await requireAggregate(ledger, "fake:42")).resumes, 0);

    await ledger.escalate({ key: "fake:42", kind: "unit", report: "no" });
    assert.deepEqual(await ledger.resumeTicket("fake:42"), { ok: true });
    const once = await requireAggregate(ledger, "fake:42");
    assert.equal(once.resumes, 1);
    assert.equal(once.state, "running");
    assert.equal(once.escalation, undefined);

    await ledger.escalate({ key: "fake:42", kind: "unit", report: "still no" });
    assert.deepEqual(await ledger.resumeTicket("fake:42"), { ok: true });
    assert.equal((await requireAggregate(ledger, "fake:42")).resumes, 2);
  });

  it("10d. an escalation keeps who refused it and when, when it is told", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admit(ticket());
    await claimKey(ledger, "proj");
    await ledger.escalate({
      key: "fake:42",
      kind: "assembly",
      report: "red",
      refusedBy: "feature-test",
    });
    const aggregate = await requireAggregate(ledger, "fake:42");
    assert.equal(aggregate.escalation?.refused_by, "feature-test");
    assert.equal(aggregate.escalation?.at, 1_000);
  });

  it("10c. an Attempt is stamped with the round it belongs to", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admit(ticket());
    await claimKey(ledger, "proj");
    const refused = { ended: "fail-retryable" as const, report: "no", refusedBy: "gate" };
    await ledger.recordAttempt({ key: "fake:42", number: 1, trace: refused });
    await ledger.escalate({ key: "fake:42", kind: "unit" });
    await ledger.resumeTicket("fake:42");
    await ledger.recordAttempt({ key: "fake:42", number: 2, trace: refused });

    const aggregate = await requireAggregate(ledger, "fake:42");
    assert.deepEqual(
      aggregate.attempts.map((attempt) => [attempt.number, attempt.round]),
      [
        [1, 0],
        [2, 1],
      ],
    );
  });

  it("10d. resumeTicket on a unit escalation runs the Ticket again; on any other kind it integrates", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await toIntegrating(ledger);
    await ledger.escalate({ key: "fake:42", kind: "assembly", report: "red" });
    await ledger.resumeTicket("fake:42");
    assert.equal((await requireAggregate(ledger, "fake:42")).state, "integrating");
  });

  it("10e. releaseBail while running spends no Attempt and keeps the workspace, without waiting for the bail", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admit(ticket());
    await claimKey(ledger, "proj");
    await ledger.declareWorkspace({ key: "fake:42", path: "/tmp/ws" });
    await ledger.startUnit("fake:42");
    const before = await requireAggregate(ledger, "fake:42");
    assert.ok(before.bail !== undefined);
    assert.ok(before.bail.expires_at > 1_000);

    assert.deepEqual(await ledger.releaseBail("fake:42"), { ok: true });
    const after = await requireAggregate(ledger, "fake:42");
    assert.equal(after.state, "running");
    assert.equal(after.bail, undefined);
    assert.equal(after.attempts_used, 0);
    assert.equal(after.workspace, "/tmp/ws");
  });

  it("10f. releaseBail on a running Ticket with nothing held is success with no rewrite", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admit(ticket());
    await claimKey(ledger, "proj");
    await ledger.startUnit("fake:42");
    await ledger.releaseBail("fake:42");
    const before = await requireAggregate(ledger, "fake:42");
    assert.deepEqual(await ledger.releaseBail("fake:42"), { ok: true });
    assert.deepEqual(await requireAggregate(ledger, "fake:42"), before);
  });

  it("10g. releaseBail refuses integrating and leaves the bail", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await toIntegrating(ledger);
    const before = await requireAggregate(ledger, "fake:42");
    assert.equal(before.state, "integrating");
    assert.ok(before.bail !== undefined);

    assert.deepEqual(await ledger.releaseBail("fake:42"), {
      ok: false,
      code: "illegal-transition",
    });
    const after = await requireAggregate(ledger, "fake:42");
    assert.equal(after.state, "integrating");
    assert.deepEqual(after.bail, before.bail);
  });

  it("10h. expireBail on a running Ticket waits for the clock, then spends an Attempt and keeps the workspace", async () => {
    const nowMs = { value: 1_000 };
    const ledger = ledgerAt(nowMs);
    await ledger.admit(ticket());
    await claimKey(ledger, "proj");
    await ledger.declareWorkspace({ key: "fake:42", path: "/tmp/ws" });
    await ledger.startUnit("fake:42");
    assert.deepEqual(await ledger.expireBail("fake:42"), {
      ok: false,
      code: "illegal-transition",
    });
    nowMs.value = 2_000;
    assert.deepEqual(await ledger.expireBail("fake:42"), { ok: true });
    const after = await requireAggregate(ledger, "fake:42");
    assert.equal(after.state, "running");
    assert.equal(after.bail, undefined);
    assert.equal(after.attempts_used, 1);
    assert.equal(after.workspace, "/tmp/ws");
  });

  it("10i. markFirstStageDone is remembered with the workspace and forgotten with it", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admit(ticket());
    await claimKey(ledger, "proj");
    assert.deepEqual(await ledger.markFirstStageDone("fake:42"), {
      ok: false,
      code: "illegal-transition",
    });
    await ledger.declareWorkspace({ key: "fake:42", path: "/tmp/ws" });
    assert.deepEqual(await ledger.markFirstStageDone("fake:42"), { ok: true });
    assert.equal((await requireAggregate(ledger, "fake:42")).first_stage_done, true);
    await ledger.startUnit("fake:42");
    await ledger.releaseBail("fake:42");
    assert.equal((await requireAggregate(ledger, "fake:42")).first_stage_done, true);
    await ledger.clearWorkspace("fake:42");
    assert.equal((await requireAggregate(ledger, "fake:42")).first_stage_done, undefined);
  });

  it("10j. a human's resume of a unit forgets the workspace: the unit starts from zero", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admit(ticket());
    await claimKey(ledger, "proj");
    await ledger.declareWorkspace({ key: "fake:42", path: "/tmp/ws" });
    await ledger.markFirstStageDone("fake:42");
    await ledger.escalate({ key: "fake:42", kind: "unit", report: "red" });
    await ledger.resumeTicket("fake:42");
    const after = await requireAggregate(ledger, "fake:42");
    assert.equal(after.state, "running");
    assert.equal(after.workspace, undefined);
    assert.equal(after.first_stage_done, undefined);
  });

  it("keeps the tracker's no_tests flag on the Ticket, and nothing when it is not set", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admit(ticket({ key: "fake:1", no_tests: true }));
    await ledger.admit(ticket({ key: "fake:2" }));
    await ledger.admit(ticket({ key: "fake:3", no_tests: false }));
    assert.equal((await requireAggregate(ledger, "fake:1")).intention.no_tests, true);
    assert.equal((await requireAggregate(ledger, "fake:2")).intention.no_tests, undefined);
    assert.equal((await requireAggregate(ledger, "fake:3")).intention.no_tests, undefined);
  });

  it("11. declareWorkspace then listDeclaredWorkspaces includes the path; clearWorkspace removes it", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admit(ticket());
    const declared = await ledger.declareWorkspace({ key: "fake:42", path: "/tmp/ws" });
    assert.deepEqual(declared, { ok: true });
    assert.deepEqual(await ledger.listDeclaredWorkspaces(), [{ key: "fake:42", path: "/tmp/ws" }]);
    const cleared = await ledger.clearWorkspace("fake:42");
    assert.deepEqual(cleared, { ok: true });
    assert.deepEqual(await ledger.listDeclaredWorkspaces(), []);
  });

  it("does not persist a refused command", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admit(ticket());
    const refused = await ledger.markIntegrating("fake:42");
    assert.deepEqual(refused, { ok: false, code: "illegal-transition" });
    const aggregate = await requireAggregate(ledger, "fake:42");
    assert.equal(aggregate.state, "received");
  });

  it("maps a failed save to persist-failed and leaves the store unchanged", async () => {
    const persist: PersistencePort = {
      async load() {
        return undefined;
      },
      async save() {
        return { ok: false, detail: "disk full" };
      },
      async listSummaries() {
        return [];
      },
    };
    const ledger = openWorkLedger({ persist, now: () => 1_000 });
    const admitted = await ledger.admit(ticket());
    assert.deepEqual(admitted, { ok: false, code: "persist-failed" });
    assert.deepEqual(await ledger.get("fake:42"), { ok: false, code: "not-found" });
  });

  it("claim with no received Ticket is empty", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    assert.deepEqual(await ledger.claim("proj"), { ok: true, empty: true });
  });

  it("claim prefers higher priority then earlier received_at", async () => {
    const nowMs = { value: 1_000 };
    const ledger = ledgerAt(nowMs);
    await ledger.admit(ticket({ key: "fake:low", priority: 1 }));
    nowMs.value = 2_000;
    await ledger.admit(ticket({ key: "fake:high", priority: 5 }));
    nowMs.value = 3_000;
    await ledger.admit(ticket({ key: "fake:also-high", priority: 5 }));
    const claimed = await ledger.claim("proj");
    assert.deepEqual(claimed, { ok: true, key: "fake:high" });
  });

  it("list returns every admitted key; a refused command does not appear", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admit(ticket({ key: "fake:1" }));
    await ledger.admit(ticket({ key: "fake:2", project: "other" }));
    const cancelled = await ledger.cancel("fake:missing");
    assert.deepEqual(cancelled, { ok: false, code: "not-found" });
    const listed = await ledger.list();
    assert.deepEqual(listed.map((row) => row.key).sort(), ["fake:1", "fake:2"]);
    assert.equal(
      listed.every((row) => row.state === "received"),
      true,
    );
  });

  it("listInFlight is the mid-flight subset of list", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admit(ticket({ key: "fake:waiting" }));
    await ledger.admit(ticket({ key: "fake:active", project: "other" }));
    await claimKey(ledger, "other");
    const listed = await ledger.list();
    const inFlight = await ledger.listInFlight();
    assert.deepEqual(listed.map((row) => row.key).sort(), ["fake:active", "fake:waiting"]);
    assert.deepEqual(
      inFlight.map((row) => row.key),
      ["fake:active"],
    );
    assert.equal(inFlight[0]?.state, "running");
  });

  it("recordAttempt stores the report that explains the Attempt", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admit(ticket());
    await claimKey(ledger, "proj");
    const recorded = await ledger.recordAttempt({
      key: "fake:42",
      number: 1,
      trace: { ended: "fail-retryable", report: "lint failed", refusedBy: "lint" },
    });
    assert.deepEqual(recorded, { ok: true });
    const aggregate = await requireAggregate(ledger, "fake:42");
    assert.equal(aggregate.attempts[0]?.trace?.report, "lint failed");
    assert.equal(aggregate.attempts[0]?.trace?.refusedBy, "lint");
  });

  it("escalate consumes a pending fingerprint", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admit(ticket());
    await claimKey(ledger, "proj");
    await ledger.admit(ticket({ fingerprint: "fp-2" }));
    const before = await requireAggregate(ledger, "fake:42");
    assert.equal(before.pending_fingerprint, "fp-2");
    const escalated = await ledger.escalate({
      key: "fake:42",
      kind: "unit",
      report: "A newer TicketStandard (fingerprint fp-2) arrived while this Ticket was in flight.",
    });
    assert.deepEqual(escalated, { ok: true });
    const after = await requireAggregate(ledger, "fake:42");
    assert.equal(after.pending_fingerprint, undefined);
    assert.equal(after.state, "escalated");
  });
});

describe("a Submission offered again", () => {
  it("keeps why it was sent back", async () => {
    const ledger = openWorkLedger({ persist: openMemoryPersist(), now: () => 1_000 });
    await toIntegrating(ledger);
    await ledger.markSubmitted({ key: "fake:42", reference: "ref-1" });
    await ledger.recordRefusal({ key: "fake:42", report: "still red", refusedBy: "ci-green" });
    await ledger.markSubmitted({ key: "fake:42", reference: "ref-1" });

    const got = await ledger.get("fake:42");
    assert.ok(got.ok);
    // The same Submission with new content, not a new one: dropping the reason
    // leaves the next escalation with a frozen Ticket and no cause.
    assert.equal(got.aggregate.submission?.last_report, "still red");
    assert.equal(got.aggregate.submission?.last_refused_by, "ci-green");
  });
});

describe("recordRealign", () => {
  it("sends a submitted ticket back to integrating, counts it, and keeps the reference", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await toIntegrating(ledger);
    await ledger.markSubmitted({ key: "fake:42", reference: "ref-1" });

    assert.deepEqual(await ledger.recordRealign({ key: "fake:42" }), { ok: true });
    const aggregate = await requireAggregate(ledger, "fake:42");
    assert.equal(aggregate.state, "integrating");
    assert.equal(aggregate.submission?.reference, "ref-1");
    assert.equal(aggregate.submission?.realigns, 1);
    // Not a refusal: the budget of refusals is untouched.
    assert.equal(aggregate.submission?.refusals, 0);
  });

  it("drops the report of an earlier refusal: it was repaired, and must not be repaired again", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await toIntegrating(ledger);
    await ledger.markSubmitted({ key: "fake:42", reference: "ref-1" });
    await ledger.recordRefusal({ key: "fake:42", report: "still red", refusedBy: "ci-green" });
    await ledger.markSubmitted({ key: "fake:42", reference: "ref-1" });
    await ledger.recordRealign({ key: "fake:42" });

    const aggregate = await requireAggregate(ledger, "fake:42");
    assert.equal(aggregate.submission?.last_report, undefined);
    assert.equal(aggregate.submission?.last_refused_by, undefined);
    assert.equal(aggregate.submission?.refusals, 1);
  });

  it("counts again each time, and the count survives an offer again", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await toIntegrating(ledger);
    await ledger.markSubmitted({ key: "fake:42", reference: "ref-1" });
    await ledger.recordRealign({ key: "fake:42" });
    await ledger.markSubmitted({ key: "fake:42", reference: "ref-1" });
    await ledger.recordRealign({ key: "fake:42" });

    const aggregate = await requireAggregate(ledger, "fake:42");
    assert.equal(aggregate.submission?.realigns, 2);
  });

  it("is refused from any state but submitted", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await toIntegrating(ledger);
    assert.deepEqual(await ledger.recordRealign({ key: "fake:42" }), {
      ok: false,
      code: "illegal-transition",
    });
  });
});

describe("recordParkedRefusal / clearParkedRefusal", () => {
  it("legal from integrating: parks the report and increments the counter", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await toIntegrating(ledger);
    const recorded = await ledger.recordParkedRefusal({
      key: "fake:42",
      report: "the diff drops the CLI flag",
      refusedBy: "assembly.validate",
    });
    assert.deepEqual(recorded, { ok: true });
    const aggregate = await requireAggregate(ledger, "fake:42");
    assert.equal(aggregate.state, "integrating");
    assert.deepEqual(aggregate.parked_refusal, {
      report: "the diff drops the CLI flag",
      refused_by: "assembly.validate",
    });
    assert.equal(aggregate.parked_refusals, 1);

    const again = await ledger.recordParkedRefusal({ key: "fake:42", report: "still missing it" });
    assert.deepEqual(again, { ok: true });
    const after = await requireAggregate(ledger, "fake:42");
    assert.equal(after.parked_refusals, 2);
    assert.deepEqual(after.parked_refusal, { report: "still missing it" });
  });

  it("illegal from any other state", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admit(ticket());
    const refused = await ledger.recordParkedRefusal({ key: "fake:42", report: "no" });
    assert.deepEqual(refused, { ok: false, code: "illegal-transition" });
  });

  it("clearParkedRefusal removes the report and leaves the counter and state alone", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await toIntegrating(ledger);
    await ledger.recordParkedRefusal({ key: "fake:42", report: "no" });
    const cleared = await ledger.clearParkedRefusal("fake:42");
    assert.deepEqual(cleared, { ok: true });
    const aggregate = await requireAggregate(ledger, "fake:42");
    assert.equal(aggregate.parked_refusal, undefined);
    assert.equal(aggregate.parked_refusals, 1);
    assert.equal(aggregate.state, "integrating");
  });

  it("clearParkedRefusal is a no-op success when nothing is parked", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await toIntegrating(ledger);
    const cleared = await ledger.clearParkedRefusal("fake:42");
    assert.deepEqual(cleared, { ok: true });
  });

  it("recordRefusal clears a stale parked refusal once a Submission has its own", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await toIntegrating(ledger);
    await ledger.recordParkedRefusal({ key: "fake:42", report: "stale" });
    await ledger.markSubmitted({ key: "fake:42", reference: "ref-1" });
    await ledger.recordRefusal({ key: "fake:42", report: "fresh", refusedBy: "ci-green" });
    const aggregate = await requireAggregate(ledger, "fake:42");
    assert.equal(aggregate.parked_refusal, undefined);
    assert.equal(aggregate.submission?.last_report, "fresh");
  });
});

/** Run a Ticket from `received` to `done`. */
async function finish(ledger: WorkLedger, key: string): Promise<void> {
  assert.deepEqual(await ledger.claim("proj"), { ok: true, key });
  await ledger.recordAttempt({ key, number: 1, trace: { ended: "validated" } });
  await ledger.markIntegrating(key);
  await ledger.markMerging(key);
  assert.deepEqual(await ledger.markDone(key), { ok: true });
}

describe("Tickets that wait on others", () => {
  it("starts a Ticket only once every Ticket it waits on is done", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admit(ticket({ key: "fake:1", priority: 1 }));
    await ledger.admit(ticket({ key: "fake:2", priority: 9, blocked_by: ["fake:1"] }));
    // The higher priority waits: its blocker has not landed.
    assert.deepEqual(await ledger.claim("proj"), { ok: true, key: "fake:1" });
    await ledger.recordAttempt({ key: "fake:1", number: 1, trace: { ended: "validated" } });
    await ledger.markIntegrating("fake:1");
    await ledger.markMerging("fake:1");
    assert.deepEqual(await ledger.claim("proj"), { ok: false, code: "project-busy" });
    await ledger.markDone("fake:1");
    assert.deepEqual(await ledger.claim("proj"), { ok: true, key: "fake:2" });
  });

  it("does not start a Ticket whose blocker nobody knows", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admit(ticket({ key: "fake:2", blocked_by: ["fake:ghost"] }));
    assert.deepEqual(await ledger.claim("proj"), { ok: true, empty: true });
    assert.equal(await ledger.nextReceived("proj"), undefined);
  });

  it("takes the next Ticket that may start, past one that may not", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admit(ticket({ key: "fake:1", priority: 1, blocked_by: ["fake:3"] }));
    await ledger.admit(ticket({ key: "fake:2", priority: 1 }));
    await ledger.admit(ticket({ key: "fake:3", priority: 1, blocked_by: ["fake:1"] }));
    assert.deepEqual(await ledger.claim("proj"), { ok: true, key: "fake:2" });
  });

  it("keeps the Feature, the blockers and the line a Ticket was admitted with", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admit(
      ticket({ key: "fake:2", feature: "fake:F", blocked_by: ["fake:1"], line: "feature/7" }),
    );
    const aggregate = await requireAggregate(ledger, "fake:2");
    assert.equal(aggregate.intention.feature, "fake:F");
    assert.deepEqual(aggregate.intention.blocked_by, ["fake:1"]);
    assert.equal(aggregate.intention.line, "feature/7");
    const [row] = await ledger.list();
    assert.equal(row?.feature, "fake:F");
  });

  it("finishes a chain in order", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admit(ticket({ key: "fake:1" }));
    await ledger.admit(ticket({ key: "fake:2", blocked_by: ["fake:1"] }));
    await finish(ledger, "fake:1");
    await finish(ledger, "fake:2");
    assert.deepEqual(
      (await ledger.list()).map((row) => row.state),
      ["done", "done"],
    );
  });
});

function intentionOf(over: Partial<FeatureAggregate["intention"]> = {}) {
  return {
    key: "fake:F1",
    project: "proj",
    fingerprint: "ffp-1",
    priority: 1,
    intention: "a feature",
    blocked_by: [],
    merge_when_ready: false,
    ...over,
  };
}

describe("Features", () => {
  it("admits a Feature as waiting, and a Ticket queries never see it", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    assert.deepEqual(await ledger.admitFeature(intentionOf()), { ok: true });
    const got = await ledger.getFeature("fake:F1");
    assert.ok(got.ok);
    assert.equal(got.aggregate.state, "waiting");
    assert.equal(got.aggregate.resumes, 0);
    assert.deepEqual(await ledger.list(), []);
    assert.deepEqual(
      (await ledger.listFeatures()).map((row) => row.key),
      ["fake:F1"],
    );
    assert.deepEqual(await ledger.get("fake:F1"), { ok: false, code: "not-found" });
    assert.deepEqual(await ledger.listDeclaredWorkspaces(), []);
  });

  it("replaces the intention of a waiting Feature that was edited", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admitFeature(intentionOf());
    await ledger.admitFeature(intentionOf());
    await ledger.admitFeature(intentionOf({ fingerprint: "ffp-2", intention: "changed" }));
    const got = await ledger.getFeature("fake:F1");
    assert.ok(got.ok);
    assert.equal(got.aggregate.intention.intention, "changed");
    assert.equal(got.aggregate.pending_fingerprint, undefined);
  });

  it("records an edit of an open Feature as pending, and ignores its echo", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admitFeature(intentionOf());
    await ledger.openFeature({ key: "fake:F1", line: "feature/1", tickets: ["fake:1"] });
    await ledger.admitFeature(intentionOf());
    await ledger.admitFeature(intentionOf({ fingerprint: "ffp-2" }));
    await ledger.admitFeature(intentionOf({ fingerprint: "ffp-2" }));
    const got = await ledger.getFeature("fake:F1");
    assert.ok(got.ok);
    assert.equal(got.aggregate.pending_fingerprint, "ffp-2");
    assert.equal(got.aggregate.intention.fingerprint, "ffp-1");
  });

  it("keeps the feature-test skip mark of a Feature, and moves it while the Feature is not submitted", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admitFeature(intentionOf({ skip_feature_test: true }));
    const waiting = await ledger.getFeature("fake:F1");
    assert.ok(waiting.ok);
    assert.equal(waiting.aggregate.intention.skip_feature_test, true);

    assert.deepEqual(await ledger.setFeatureSkipFeatureTest({ key: "fake:F1", skip: false }), {
      ok: true,
    });
    const cleared = await ledger.getFeature("fake:F1");
    assert.ok(cleared.ok);
    assert.equal(cleared.aggregate.intention.skip_feature_test, undefined);

    await ledger.openFeature({ key: "fake:F1", line: "feature/1", tickets: ["fake:1"] });
    assert.deepEqual(await ledger.setFeatureSkipFeatureTest({ key: "fake:F1", skip: true }), {
      ok: true,
    });
    await ledger.markFeatureSubmitted({ key: "fake:F1", reference: "pr-1" });
    assert.deepEqual(await ledger.setFeatureSkipFeatureTest({ key: "fake:F1", skip: false }), {
      ok: false,
      code: "illegal-transition",
    });
    assert.deepEqual(await ledger.setFeatureSkipFeatureTest({ key: "fake:nope", skip: true }), {
      ok: false,
      code: "not-found",
    });
  });

  it("keeps the feature-test mark of a Ticket on its admission", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admit(ticket({ featureTest: true }));
    const got = await ledger.get("fake:42");
    assert.ok(got.ok);
    assert.equal(got.aggregate.intention.featureTest, true);
  });

  it("opens the highest priority, then the oldest, that no Feature blocks", async () => {
    const nowMs = { value: 1_000 };
    const ledger = ledgerAt(nowMs);
    await ledger.admitFeature(intentionOf({ key: "fake:A", priority: 1 }));
    nowMs.value = 2_000;
    await ledger.admitFeature(intentionOf({ key: "fake:B", priority: 5 }));
    nowMs.value = 3_000;
    await ledger.admitFeature(intentionOf({ key: "fake:C", priority: 5 }));
    await ledger.admitFeature(intentionOf({ key: "fake:D", priority: 99, blocked_by: ["fake:A"] }));
    assert.equal((await ledger.nextFeature("proj"))?.key, "fake:B");
    assert.equal(await ledger.nextFeature("other"), undefined);
  });

  it("opens one Feature at a time on a Project", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admitFeature(intentionOf({ key: "fake:A" }));
    await ledger.admitFeature(intentionOf({ key: "fake:B" }));
    assert.deepEqual(await ledger.openFeature({ key: "fake:A", line: "feature/a", tickets: [] }), {
      ok: true,
    });
    assert.equal(await ledger.nextFeature("proj"), undefined);
    assert.deepEqual(await ledger.openFeature({ key: "fake:B", line: "feature/b", tickets: [] }), {
      ok: false,
      code: "project-busy",
    });
    assert.equal((await ledger.activeFeatureOn("proj"))?.key, "fake:A");
  });

  it("opens a Feature that waited for its blocker once the blocker is done", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admitFeature(intentionOf({ key: "fake:A" }));
    await ledger.admitFeature(intentionOf({ key: "fake:B", blocked_by: ["fake:A"] }));
    await ledger.openFeature({ key: "fake:A", line: "feature/a", tickets: [] });
    await ledger.markFeatureSubmitted({ key: "fake:A", reference: "pr-1" });
    assert.equal(await ledger.nextFeature("proj"), undefined);
    assert.deepEqual(await ledger.markFeatureDone("fake:A", { reference: "abc" }), { ok: true });
    assert.equal((await ledger.nextFeature("proj"))?.key, "fake:B");
    const done = await ledger.getFeature("fake:A");
    assert.ok(done.ok);
    assert.equal(done.aggregate.integration_reference, "abc");
    assert.equal(done.aggregate.submission?.reference, "pr-1");
  });

  it("keeps the line and the Tickets it opened with", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admitFeature(intentionOf());
    await ledger.openFeature({ key: "fake:F1", line: "feature/1", tickets: ["fake:1", "fake:2"] });
    const got = await ledger.getFeature("fake:F1");
    assert.ok(got.ok);
    assert.equal(got.aggregate.state, "open");
    assert.equal(got.aggregate.line, "feature/1");
    assert.deepEqual(got.aggregate.tickets, ["fake:1", "fake:2"]);
  });

  it("refuses the moves a state does not allow", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admitFeature(intentionOf());
    const illegal = { ok: false, code: "illegal-transition" };
    assert.deepEqual(
      await ledger.markFeatureSubmitted({ key: "fake:F1", reference: "r" }),
      illegal,
    );
    assert.deepEqual(await ledger.markFeatureDone("fake:F1"), illegal);
    assert.deepEqual(await ledger.escalateFeature({ key: "fake:F1" }), illegal);
    assert.deepEqual(await ledger.resumeFeature("fake:F1"), illegal);
    assert.deepEqual(await ledger.openFeature({ key: "fake:none", line: "l", tickets: [] }), {
      ok: false,
      code: "not-found",
    });
  });

  it("escalates a Feature, consumes a pending edit, and resumes it a round later", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admitFeature(intentionOf());
    await ledger.openFeature({ key: "fake:F1", line: "feature/1", tickets: [] });
    await ledger.admitFeature(intentionOf({ fingerprint: "ffp-2" }));
    await ledger.markFeatureSubmitted({ key: "fake:F1", reference: "pr-1" });
    assert.deepEqual(await ledger.escalateFeature({ key: "fake:F1", report: "checks red" }), {
      ok: true,
    });
    let got = await ledger.getFeature("fake:F1");
    assert.ok(got.ok);
    assert.equal(got.aggregate.state, "escalated");
    assert.equal(got.aggregate.escalation?.report, "checks red");
    assert.equal(got.aggregate.pending_fingerprint, undefined);
    assert.equal((await ledger.activeFeatureOn("proj"))?.state, "escalated");

    assert.deepEqual(await ledger.resumeFeature("fake:F1"), { ok: true });
    got = await ledger.getFeature("fake:F1");
    assert.ok(got.ok);
    assert.equal(got.aggregate.state, "open");
    assert.equal(got.aggregate.resumes, 1);
    assert.equal(got.aggregate.escalation, undefined);
    assert.equal(got.aggregate.submission?.reference, "pr-1");
  });

  it("marks a resumed Feature's work stale until it is said to be current", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admitFeature(intentionOf());
    await ledger.openFeature({ key: "fake:F1", line: "feature/1", tickets: [] });
    assert.deepEqual(await ledger.markFeatureWorkspaceCurrent("fake:none"), {
      ok: false,
      code: "not-found",
    });
    await ledger.escalateFeature({ key: "fake:F1", report: "checks red" });
    assert.deepEqual(await ledger.markFeatureWorkspaceCurrent("fake:F1"), {
      ok: false,
      code: "illegal-transition",
    });
    await ledger.resumeFeature("fake:F1");
    let got = await ledger.getFeature("fake:F1");
    assert.ok(got.ok);
    assert.equal(got.aggregate.workspace_stale, true);
    assert.deepEqual(await ledger.markFeatureWorkspaceCurrent("fake:F1"), { ok: true });
    got = await ledger.getFeature("fake:F1");
    assert.ok(got.ok);
    assert.equal(got.aggregate.workspace_stale, undefined);
  });

  it("keeps where a Feature stopped and who refused it, when it is told", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admitFeature(intentionOf());
    await ledger.openFeature({ key: "fake:F1", line: "feature/1", tickets: [] });
    await ledger.escalateFeature({
      key: "fake:F1",
      report: "featureTest: too many",
      kind: "assembly",
      refusedBy: "feature-test",
    });
    const got = await ledger.getFeature("fake:F1");
    assert.ok(got.ok);
    assert.deepEqual(got.aggregate.escalation, {
      report: "featureTest: too many",
      kind: "assembly",
      refused_by: "feature-test",
      at: 1_000,
    });
  });

  it("cancels a Feature that is not done, and refuses one that is", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admitFeature(intentionOf({ key: "fake:A" }));
    await ledger.admitFeature(intentionOf({ key: "fake:B" }));
    assert.deepEqual(await ledger.cancelFeature("fake:A"), { ok: true });
    assert.deepEqual(await ledger.cancelFeature("fake:A"), { ok: true });
    assert.deepEqual(await ledger.admitFeature(intentionOf({ key: "fake:A" })), {
      ok: false,
      code: "illegal-transition",
    });
    await ledger.openFeature({ key: "fake:B", line: "feature/b", tickets: [] });
    await ledger.markFeatureSubmitted({ key: "fake:B", reference: "pr" });
    await ledger.markFeatureDone("fake:B");
    assert.deepEqual(await ledger.cancelFeature("fake:B"), {
      ok: false,
      code: "point-of-no-return",
    });
    assert.deepEqual(await ledger.admitFeature(intentionOf({ key: "fake:B" })), {
      ok: false,
      code: "too-late",
    });
    assert.deepEqual(await ledger.cancelFeature("fake:none"), { ok: false, code: "not-found" });
  });
});

describe("claiming several Tickets of a Project", () => {
  it("claims up to the limit, then says the Project is busy", async () => {
    const ledger = openWorkLedger({ persist: openMemoryPersist() });
    for (const n of [1, 2, 3]) {
      await ledger.admit(ticket({ key: `fake:${n}`, fingerprint: `fp-${n}`, priority: 10 - n }));
    }
    assert.deepEqual(await ledger.claim("proj", 2), { ok: true, key: "fake:1" });
    assert.deepEqual(await ledger.claim("proj", 2), { ok: true, key: "fake:2" });
    assert.deepEqual(await ledger.claim("proj", 2), { ok: false, code: "project-busy" });
    assert.equal((await ledger.activeTickets("proj")).length, 2);
  });

  it("holds a place for an escalated Ticket", async () => {
    const ledger = openWorkLedger({ persist: openMemoryPersist() });
    await ledger.admit(ticket({ key: "fake:1", fingerprint: "fp-1" }));
    await ledger.admit(ticket({ key: "fake:2", fingerprint: "fp-2", priority: 0 }));
    await ledger.claim("proj", 2);
    await ledger.recordAttempt({ key: "fake:1", number: 1, trace: { ended: "fail-blocking" } });
    await ledger.escalate({ key: "fake:1", kind: "unit" });
    assert.deepEqual(await ledger.claim("proj", 2), { ok: true, key: "fake:2" });
    assert.deepEqual(await ledger.claim("proj", 2), { ok: false, code: "project-busy" });
  });

  it("never hands the same Ticket to two claims made together", async () => {
    const ledger = openWorkLedger({ persist: openMemoryPersist() });
    for (const n of [1, 2, 3]) {
      await ledger.admit(ticket({ key: `fake:${n}`, fingerprint: `fp-${n}`, priority: 10 - n }));
    }
    const claims = await Promise.all([1, 2, 3].map(() => ledger.claim("proj", 3)));
    const keys = claims.map((claim) => ("key" in claim ? claim.key : undefined));
    assert.deepEqual([...keys].sort(), ["fake:1", "fake:2", "fake:3"]);
  });

  it("does not go past the limit when claims are made together", async () => {
    const ledger = openWorkLedger({ persist: openMemoryPersist() });
    for (const n of [1, 2, 3]) {
      await ledger.admit(ticket({ key: `fake:${n}`, fingerprint: `fp-${n}` }));
    }
    const claims = await Promise.all([1, 2, 3].map(() => ledger.claim("proj", 2)));
    assert.equal(claims.filter((claim) => "key" in claim).length, 2);
    assert.equal((await ledger.activeTickets("proj")).length, 2);
  });

  it("starts a Ticket only once every Ticket it waits on is done", async () => {
    const ledger = openWorkLedger({ persist: openMemoryPersist() });
    await ledger.admit(ticket({ key: "fake:a", fingerprint: "fp-a" }));
    await ledger.admit(
      ticket({ key: "fake:c", fingerprint: "fp-c", priority: 99, blocked_by: ["fake:a"] }),
    );
    assert.deepEqual(await ledger.claim("proj", 3), { ok: true, key: "fake:a" });
    // The dependent has the higher priority, and still waits.
    assert.deepEqual(await ledger.claim("proj", 3), { ok: true, empty: true });
    await ledger.recordAttempt({ key: "fake:a", number: 1, trace: { ended: "validated" } });
    await ledger.markIntegrating("fake:a");
    assert.deepEqual(await ledger.claim("proj", 3), { ok: true, empty: true });
    await ledger.markMerging("fake:a");
    await ledger.markDone("fake:a");
    assert.deepEqual(await ledger.claim("proj", 3), { ok: true, key: "fake:c" });
  });
});
