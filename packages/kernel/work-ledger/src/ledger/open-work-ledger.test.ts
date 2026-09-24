import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PersistencePort } from "../persist/port.js";
import type { FeatureAggregate, FeatureSummary } from "../records.js";
import type { PlanDraft } from "./check-plan.js";
import { type FeatureAdmission, openWorkLedger, type WorkLedger } from "./open-work-ledger.js";

function toSummary(aggregate: FeatureAggregate): FeatureSummary {
  const summary: FeatureSummary = {
    key: aggregate.intention.key,
    project: aggregate.intention.project,
    state: aggregate.state,
    priority: aggregate.intention.priority,
    received_at: aggregate.received_at,
  };
  if (aggregate.bail !== undefined) {
    summary.bail_expires_at = aggregate.bail.expires_at;
  }
  return summary;
}

/** Test-double Persistence Port. Lives in this test file, not as a shipping adapter. */
function openMemoryPersist(): PersistencePort {
  const store = new Map<string, FeatureAggregate>();
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

function feature(over: Partial<FeatureAdmission> = {}): FeatureAdmission {
  return {
    key: "fake:42",
    project: "proj",
    fingerprint: "fp-1",
    priority: 1,
    intention: "do the thing",
    ...over,
  };
}

function twoSubtasks(): PlanDraft[] {
  return [
    { id: "A", intention: "first", definition_of_done: "A done", depends_on: [] },
    { id: "B", intention: "second", definition_of_done: "B done", depends_on: ["A"] },
  ];
}

function ledgerAt(nowMs: { value: number }): WorkLedger {
  return openWorkLedger({
    persist: openMemoryPersist(),
    now: () => nowMs.value,
    bailDurationMs: 1_000,
  });
}

async function requireAggregate(ledger: WorkLedger, key: string): Promise<FeatureAggregate> {
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
  it("1. admit of a new FeatureStandard is received with that key and fingerprint", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    const admitted = await ledger.admit(feature());
    assert.deepEqual(admitted, { ok: true });
    const aggregate = await requireAggregate(ledger, "fake:42");
    assert.equal(aggregate.state, "received");
    assert.equal(aggregate.intention.key, "fake:42");
    assert.equal(aggregate.intention.fingerprint, "fp-1");
  });

  it("2. admit of the same key and fingerprint is success with no rewrite", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admit(feature());
    const first = await requireAggregate(ledger, "fake:42");
    const admitted = await ledger.admit(feature());
    assert.deepEqual(admitted, { ok: true });
    const second = await requireAggregate(ledger, "fake:42");
    assert.equal(second.intention.fingerprint, first.intention.fingerprint);
    assert.equal(second.intention.intention, first.intention.intention);
    assert.equal(second.received_at, first.received_at);
  });

  it("3. admit of the same key with a new fingerprint while received updates the intention", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admit(feature());
    const admitted = await ledger.admit(
      feature({ fingerprint: "fp-2", intention: "do it differently" }),
    );
    assert.deepEqual(admitted, { ok: true });
    const aggregate = await requireAggregate(ledger, "fake:42");
    assert.equal(aggregate.state, "received");
    assert.equal(aggregate.intention.fingerprint, "fp-2");
    assert.equal(aggregate.intention.intention, "do it differently");
  });

  it("4. admit while running sets pending fingerprint and leaves the Plan and state", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admit(feature());
    await claimKey(ledger, "proj");
    const planned = await ledger.recordPlan({
      key: "fake:42",
      plannedAt: "2026-01-01T00:00:00.000Z",
      subtasks: twoSubtasks(),
    });
    assert.deepEqual(planned, { ok: true });
    const before = await requireAggregate(ledger, "fake:42");
    const admitted = await ledger.admit(feature({ fingerprint: "fp-2" }));
    assert.deepEqual(admitted, { ok: true });
    const after = await requireAggregate(ledger, "fake:42");
    assert.equal(after.state, "running");
    assert.equal(after.pending_fingerprint, "fp-2");
    assert.deepEqual(after.plan, before.plan);
  });

  it("4b. admit of the same fingerprint while in flight leaves the record unchanged", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admit(feature());
    await claimKey(ledger, "proj");
    await ledger.recordPlan({
      key: "fake:42",
      plannedAt: "2026-01-01T00:00:00.000Z",
      subtasks: twoSubtasks(),
    });
    const before = await requireAggregate(ledger, "fake:42");
    const admitted = await ledger.admit(feature());
    assert.deepEqual(admitted, { ok: true });
    const after = await requireAggregate(ledger, "fake:42");
    assert.equal(after.pending_fingerprint, undefined);
    assert.deepEqual(after, before);
  });

  it("4c. admit of the same fingerprint while submitted leaves the record unchanged", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admit(feature());
    await claimKey(ledger, "proj");
    await ledger.recordPlan({
      key: "fake:42",
      plannedAt: "2026-01-01T00:00:00.000Z",
      subtasks: [{ id: "a", intention: "i", definition_of_done: "d", depends_on: [] }],
    });
    await ledger.startSubtask({ key: "fake:42", subtaskId: "a" });
    await ledger.recordAttempt({
      key: "fake:42",
      subtaskId: "a",
      number: 1,
      trace: { ended: "validated" },
    });
    await ledger.markSubtaskIntegrated({ key: "fake:42", subtaskId: "a" });
    await ledger.markSubmitted({ key: "fake:42", reference: "ref-1" });
    const before = await requireAggregate(ledger, "fake:42");
    assert.equal(before.state, "submitted");

    const echo = await ledger.admit(feature());
    assert.deepEqual(echo, { ok: true });
    const afterEcho = await requireAggregate(ledger, "fake:42");
    assert.equal(afterEcho.pending_fingerprint, undefined);
    assert.deepEqual(afterEcho, before);

    const edited = await ledger.admit(feature({ fingerprint: "fp-2" }));
    assert.deepEqual(edited, { ok: true });
    const afterEdit = await requireAggregate(ledger, "fake:42");
    assert.equal(afterEdit.state, "submitted");
    assert.equal(afterEdit.pending_fingerprint, "fp-2");
    assert.equal(afterEdit.intention.fingerprint, "fp-1");

    const echoOfEdit = await ledger.admit(feature({ fingerprint: "fp-2" }));
    assert.deepEqual(echoOfEdit, { ok: true });
    const afterEchoOfEdit = await requireAggregate(ledger, "fake:42");
    assert.deepEqual(afterEchoOfEdit, afterEdit);
  });

  it("5. claim takes the received Feature then a second claim is project-busy", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admit(feature());
    const claimed = await ledger.claim("proj");
    assert.deepEqual(claimed, { ok: true, key: "fake:42" });
    const aggregate = await requireAggregate(ledger, "fake:42");
    assert.equal(aggregate.state, "planning");
    assert.equal(aggregate.bail?.expires_at, 2_000);
    const second = await ledger.claim("proj");
    assert.deepEqual(second, { ok: false, code: "project-busy" });
  });

  it("6. recordPlan with B depending on A: A runnable, B pending; startSubtask(B) is refused", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admit(feature());
    await claimKey(ledger, "proj");
    const planned = await ledger.recordPlan({
      key: "fake:42",
      plannedAt: "2026-01-01T00:00:00.000Z",
      subtasks: twoSubtasks(),
    });
    assert.deepEqual(planned, { ok: true });
    const aggregate = await requireAggregate(ledger, "fake:42");
    assert.equal(aggregate.plan?.subtasks.find((st) => st.id === "A")?.state, "runnable");
    assert.equal(aggregate.plan?.subtasks.find((st) => st.id === "B")?.state, "pending");
    const started = await ledger.startSubtask({ key: "fake:42", subtaskId: "B" });
    assert.deepEqual(started, { ok: false, code: "subtask-not-runnable" });
  });

  it("7. startSubtask of a second Subtask while one is running is another-running", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admit(feature());
    await claimKey(ledger, "proj");
    await ledger.recordPlan({
      key: "fake:42",
      plannedAt: "2026-01-01T00:00:00.000Z",
      subtasks: twoSubtasks(),
    });
    const first = await ledger.startSubtask({ key: "fake:42", subtaskId: "A" });
    assert.deepEqual(first, { ok: true });
    const second = await ledger.startSubtask({ key: "fake:42", subtaskId: "B" });
    assert.deepEqual(second, { ok: false, code: "another-running" });
  });

  it("8. markSubtaskIntegrated on the last non-terminal Subtask moves the Feature to integrating", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admit(feature());
    await claimKey(ledger, "proj");
    await ledger.recordPlan({
      key: "fake:42",
      plannedAt: "2026-01-01T00:00:00.000Z",
      subtasks: twoSubtasks(),
    });
    await ledger.startSubtask({ key: "fake:42", subtaskId: "A" });
    const first = await ledger.markSubtaskIntegrated({ key: "fake:42", subtaskId: "A" });
    assert.deepEqual(first, { ok: true });
    let aggregate = await requireAggregate(ledger, "fake:42");
    assert.equal(aggregate.state, "running");
    assert.equal(aggregate.plan?.subtasks.find((st) => st.id === "B")?.state, "runnable");
    await ledger.startSubtask({ key: "fake:42", subtaskId: "B" });
    const last = await ledger.markSubtaskIntegrated({ key: "fake:42", subtaskId: "B" });
    assert.deepEqual(last, { ok: true });
    aggregate = await requireAggregate(ledger, "fake:42");
    assert.equal(aggregate.state, "integrating");
  });

  it("9. cancel in merging is point-of-no-return and leaves merging", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admit(feature());
    await claimKey(ledger, "proj");
    await ledger.recordPlan({
      key: "fake:42",
      plannedAt: "2026-01-01T00:00:00.000Z",
      subtasks: [{ id: "A", intention: "first", definition_of_done: "A done", depends_on: [] }],
    });
    await ledger.startSubtask({ key: "fake:42", subtaskId: "A" });
    await ledger.markSubtaskIntegrated({ key: "fake:42", subtaskId: "A" });
    await ledger.markMerging("fake:42");
    const cancelled = await ledger.cancel("fake:42");
    assert.deepEqual(cancelled, { ok: false, code: "point-of-no-return" });
    const aggregate = await requireAggregate(ledger, "fake:42");
    assert.equal(aggregate.state, "merging");
  });

  it("10. escalate after recordAttempt without a Trace is missing-trace", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admit(feature());
    await claimKey(ledger, "proj");
    await ledger.recordPlan({
      key: "fake:42",
      plannedAt: "2026-01-01T00:00:00.000Z",
      subtasks: [{ id: "A", intention: "first", definition_of_done: "A done", depends_on: [] }],
    });
    await ledger.startSubtask({ key: "fake:42", subtaskId: "A" });
    const recorded = await ledger.recordAttempt({ key: "fake:42", subtaskId: "A", number: 1 });
    assert.deepEqual(recorded, { ok: true });
    const escalated = await ledger.escalate({ key: "fake:42", kind: "subtask", subtaskId: "A" });
    assert.deepEqual(escalated, { ok: false, code: "missing-trace" });
    const aggregate = await requireAggregate(ledger, "fake:42");
    assert.equal(aggregate.state, "running");
  });

  it("10b. resumeReady counts the rounds, so two escalations of one kind can be told apart", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admit(feature());
    await claimKey(ledger, "proj");
    assert.equal((await requireAggregate(ledger, "fake:42")).resumes, undefined);

    // A plan refused, resumed, and refused again leaves the Attempt count where
    // it was; only the round moves.
    await ledger.refusePlan({ key: "fake:42", code: "bad", reason: "no" });
    assert.deepEqual(await ledger.resumeReady("fake:42"), { ok: true });
    const once = await requireAggregate(ledger, "fake:42");
    assert.equal(once.resumes, 1);
    assert.equal(once.state, "planning");
    assert.equal(once.attempts_used, 0);

    await ledger.refusePlan({ key: "fake:42", code: "bad", reason: "still no" });
    assert.deepEqual(await ledger.resumeReady("fake:42"), { ok: true });
    const twice = await requireAggregate(ledger, "fake:42");
    assert.equal(twice.resumes, 2);
    assert.equal(twice.attempts_used, 0);
  });

  it("10c. an Attempt is stamped with the round it belongs to", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admit(feature());
    await claimKey(ledger, "proj");
    await ledger.recordPlan({
      key: "fake:42",
      plannedAt: "2026-01-01T00:00:00.000Z",
      subtasks: [{ id: "A", intention: "first", definition_of_done: "A done", depends_on: [] }],
    });
    const refused = { ended: "fail-retryable" as const, report: "no", refusedBy: "gate" };
    await ledger.startSubtask({ key: "fake:42", subtaskId: "A" });
    await ledger.recordAttempt({ key: "fake:42", subtaskId: "A", number: 1, trace: refused });
    await ledger.escalate({ key: "fake:42", kind: "subtask", subtaskId: "A" });
    await ledger.resumeReady("fake:42");
    await ledger.startSubtask({ key: "fake:42", subtaskId: "A" });
    await ledger.recordAttempt({ key: "fake:42", subtaskId: "A", number: 2, trace: refused });

    const aggregate = await requireAggregate(ledger, "fake:42");
    assert.deepEqual(
      aggregate.attempts.map((attempt) => [attempt.number, attempt.round]),
      [
        [1, 0],
        [2, 1],
      ],
    );
  });

  it("11. declareWorkspace then listDeclaredWorkspaces includes the path; clearWorkspace removes it", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admit(feature());
    const declared = await ledger.declareWorkspace({
      key: "fake:42",
      feature: "/tmp/ws-feature",
    });
    assert.deepEqual(declared, { ok: true });
    assert.deepEqual(await ledger.listDeclaredWorkspaces(), [
      { key: "fake:42", feature: "/tmp/ws-feature" },
    ]);
    const cleared = await ledger.clearWorkspace({ key: "fake:42", feature: true });
    assert.deepEqual(cleared, { ok: true });
    assert.deepEqual(await ledger.listDeclaredWorkspaces(), []);
  });

  it("does not persist a refused command", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admit(feature());
    const refused = await ledger.startSubtask({ key: "fake:42", subtaskId: "A" });
    assert.deepEqual(refused, { ok: false, code: "plan-not-frozen" });
    const aggregate = await requireAggregate(ledger, "fake:42");
    assert.equal(aggregate.state, "received");
    assert.equal(aggregate.plan, undefined);
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
    const admitted = await ledger.admit(feature());
    assert.deepEqual(admitted, { ok: false, code: "persist-failed" });
    assert.deepEqual(await ledger.get("fake:42"), { ok: false, code: "not-found" });
  });

  it("claim with no received Feature is empty", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    assert.deepEqual(await ledger.claim("proj"), { ok: true, empty: true });
  });

  it("claim prefers higher priority then earlier received_at", async () => {
    const nowMs = { value: 1_000 };
    const ledger = ledgerAt(nowMs);
    await ledger.admit(feature({ key: "fake:low", priority: 1 }));
    nowMs.value = 2_000;
    await ledger.admit(feature({ key: "fake:high", priority: 5 }));
    nowMs.value = 3_000;
    await ledger.admit(feature({ key: "fake:also-high", priority: 5 }));
    const claimed = await ledger.claim("proj");
    assert.deepEqual(claimed, { ok: true, key: "fake:high" });
  });

  it("nextRunnable prefers the Subtask that unblocks the most others", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admit(feature());
    await claimKey(ledger, "proj");
    await ledger.recordPlan({
      key: "fake:42",
      plannedAt: "2026-01-01T00:00:00.000Z",
      subtasks: [
        { id: "A", intention: "first", definition_of_done: "A done", depends_on: [] },
        { id: "B", intention: "second", definition_of_done: "B done", depends_on: [] },
        { id: "C", intention: "third", definition_of_done: "C done", depends_on: ["A", "B"] },
        { id: "D", intention: "fourth", definition_of_done: "D done", depends_on: ["A"] },
      ],
    });
    assert.equal(await ledger.nextRunnable("fake:42"), "A");
  });

  it("list returns every admitted key; a refused command does not appear", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admit(feature({ key: "fake:1" }));
    await ledger.admit(feature({ key: "fake:2", project: "other" }));
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
    await ledger.admit(feature({ key: "fake:waiting" }));
    await ledger.admit(feature({ key: "fake:active", project: "other" }));
    await claimKey(ledger, "other");
    const listed = await ledger.list();
    const inFlight = await ledger.listInFlight();
    assert.deepEqual(listed.map((row) => row.key).sort(), ["fake:active", "fake:waiting"]);
    assert.deepEqual(
      inFlight.map((row) => row.key),
      ["fake:active"],
    );
    assert.equal(inFlight[0]?.state, "planning");
  });

  it("recordAttempt stores the report that explains the Attempt", async () => {
    const ledger = ledgerAt({ value: 1_000 });
    await ledger.admit(feature());
    await claimKey(ledger, "proj");
    await ledger.recordPlan({
      key: "fake:42",
      plannedAt: "2026-01-01T00:00:00.000Z",
      subtasks: twoSubtasks(),
    });
    await ledger.startSubtask({ key: "fake:42", subtaskId: "A" });
    const recorded = await ledger.recordAttempt({
      key: "fake:42",
      subtaskId: "A",
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
    await ledger.admit(feature());
    await claimKey(ledger, "proj");
    await ledger.recordPlan({
      key: "fake:42",
      plannedAt: "2026-01-01T00:00:00.000Z",
      subtasks: twoSubtasks(),
    });
    await ledger.admit(feature({ fingerprint: "fp-2" }));
    const before = await requireAggregate(ledger, "fake:42");
    assert.equal(before.pending_fingerprint, "fp-2");
    const escalated = await ledger.escalate({
      key: "fake:42",
      kind: "plan",
      report:
        "A newer FeatureStandard (fingerprint fp-2) arrived while this Feature was in flight.",
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
    await ledger.admit(feature());
    await claimKey(ledger, "proj");
    await ledger.recordPlan({
      key: "fake:42",
      plannedAt: "2026-01-01T00:00:00.000Z",
      subtasks: [{ id: "a", intention: "i", definition_of_done: "d", depends_on: [] }],
    });
    await ledger.startSubtask({ key: "fake:42", subtaskId: "a" });
    await ledger.recordAttempt({
      key: "fake:42",
      subtaskId: "a",
      number: 1,
      trace: { ended: "validated" },
    });
    await ledger.markSubtaskIntegrated({ key: "fake:42", subtaskId: "a" });
    await ledger.markSubmitted({ key: "fake:42", reference: "ref-1" });
    await ledger.recordRefusal({ key: "fake:42", report: "still red", refusedBy: "ci-green" });
    await ledger.markSubmitted({ key: "fake:42", reference: "ref-1" });

    const got = await ledger.get("fake:42");
    assert.ok(got.ok);
    // The same Submission with new content, not a new one: dropping the reason
    // leaves the next escalation with a frozen Feature and no cause.
    assert.equal(got.aggregate.submission?.last_report, "still red");
    assert.equal(got.aggregate.submission?.last_refused_by, "ci-green");
  });
});

describe("recordParkedRefusal / clearParkedRefusal", () => {
  async function toIntegrating(ledger: WorkLedger): Promise<void> {
    await ledger.admit(feature());
    await claimKey(ledger, "proj");
    await ledger.recordPlan({
      key: "fake:42",
      plannedAt: "2026-01-01T00:00:00.000Z",
      subtasks: [{ id: "a", intention: "i", definition_of_done: "d", depends_on: [] }],
    });
    await ledger.startSubtask({ key: "fake:42", subtaskId: "a" });
    await ledger.recordAttempt({
      key: "fake:42",
      subtaskId: "a",
      number: 1,
      trace: { ended: "validated" },
    });
    await ledger.markSubtaskIntegrated({ key: "fake:42", subtaskId: "a" });
  }

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
    await ledger.admit(feature());
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
