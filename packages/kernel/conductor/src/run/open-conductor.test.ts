import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { PersistencePort } from "@bluewombat/work-ledger";
import {
  type FeatureAdmission,
  type FeatureAggregate,
  type FeatureSummary,
  openWorkLedger,
} from "@bluewombat/work-ledger";
import type { AuthorityPort, ImplementResult, TransformerPort } from "../transformers/port.js";
import { type ConductorMoment, openConductor } from "./open-conductor.js";
import { featureWorkspacePath, subtaskWorkspacePath } from "./paths.js";

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

type Call = { op: string; id?: string; parent?: string; child?: string; workspace?: string };

function recordingTransformers(over: Partial<TransformerPort> = {}): {
  transformers: TransformerPort;
  calls: Call[];
} {
  const calls: Call[] = [];
  const transformers: TransformerPort = {
    async isolate(input) {
      calls.push({ op: "isolate", id: input.id, parent: input.parent, child: input.child });
      mkdirSync(input.child, { recursive: true });
      return { outcome: "isolated" };
    },
    async breakDown() {
      calls.push({ op: "breakDown" });
      return {
        outcome: "planned",
        plannedAt: "2026-01-01T00:00:00.000Z",
        subtasks: [
          {
            id: "A",
            intention: "first",
            definition_of_done: "A done",
            depends_on: [],
          },
        ],
      };
    },
    async implement(input) {
      calls.push({ op: "implement", id: input.id, workspace: input.workspace });
      return { outcome: "validated", traces: [{ ended: "validated" }] };
    },
    async integrate(input) {
      calls.push({ op: "integrate", id: input.id, parent: input.parent, child: input.child });
      return { outcome: "integrated" };
    },
    ...over,
  };
  return { transformers, calls };
}

function tempPair(): { stable: string; root: string } {
  const dir = mkdtempSync(join(tmpdir(), "conductor-"));
  const stable = join(dir, "stable");
  const root = join(dir, "workspaces");
  mkdirSync(stable);
  mkdirSync(root);
  writeFileSync(join(stable, "seed.txt"), "stable\n");
  return { stable, root };
}

describe("openConductor", () => {
  it("1. claims and records the Plan before any isolate", async () => {
    const { stable, root } = tempPair();
    const { transformers, calls } = recordingTransformers();
    const ledger = openWorkLedger({ persist: openMemoryPersist(), now: () => 1_000 });
    await ledger.admit(feature());
    const conductor = openConductor({
      ledger,
      transformers,
      workLineStable: stable,
      workspaceRoot: root,
    });
    const result = await conductor.runProject("proj");
    assert.equal(result.outcome, "done");
    const ops = calls.map((c) => c.op);
    assert.equal(ops.indexOf("breakDown") < ops.indexOf("isolate"), true);
    assert.equal(ops[0], "breakDown");
  });

  it("2. declareWorkspace is recorded before isolate of that path", async () => {
    const { stable, root } = tempPair();
    const ledger = openWorkLedger({ persist: openMemoryPersist(), now: () => 1_000 });
    await ledger.admit(feature());
    const featurePath = featureWorkspacePath(root, "fake:42");
    const subtaskPath = subtaskWorkspacePath(root, "fake:42", "A");
    let featureDeclared = false;
    let subtaskDeclared = false;
    const { transformers } = recordingTransformers({
      async isolate(input) {
        const got = await ledger.get("fake:42");
        assert.equal(got.ok, true);
        if (input.child === featurePath) {
          featureDeclared = got.ok && got.aggregate.workspaces?.feature === featurePath;
        }
        if (input.child === subtaskPath) {
          subtaskDeclared = got.ok && got.aggregate.workspaces?.subtask === subtaskPath;
        }
        mkdirSync(input.child, { recursive: true });
        return { outcome: "isolated" };
      },
    });
    const conductor = openConductor({
      ledger,
      transformers,
      workLineStable: stable,
      workspaceRoot: root,
    });
    await conductor.runProject("proj");
    assert.equal(featureDeclared, true);
    assert.equal(subtaskDeclared, true);
  });

  it("3. happy path: two isolates, three integrates, Subtask then judgement", async () => {
    const { stable, root } = tempPair();
    const { transformers, calls } = recordingTransformers();
    const ledger = openWorkLedger({ persist: openMemoryPersist(), now: () => 1_000 });
    await ledger.admit(feature());
    const conductor = openConductor({
      ledger,
      transformers,
      workLineStable: stable,
      workspaceRoot: root,
    });
    const result = await conductor.runProject("proj");
    assert.deepEqual(result, { outcome: "done", key: "fake:42" });
    const got = await ledger.get("fake:42");
    assert.equal(got.ok && got.aggregate.state, "done");
    assert.equal(calls.filter((c) => c.op === "isolate").length, 2);
    assert.equal(calls.filter((c) => c.op === "integrate").length, 3);
    // The Subtask produces; the assembled feature is judged and makes nothing.
    // With no Authority that judgement is the only one it gets.
    const implements_ = calls.filter((c) => c.op === "implement");
    assert.equal(implements_.length, 2);
    assert.equal(implements_[1]?.id, "fake:42:judgement");
  });

  it("4. breakdown refused escalates and never isolates", async () => {
    const { stable, root } = tempPair();
    const { transformers, calls } = recordingTransformers({
      async breakDown() {
        return { outcome: "refused", code: "empty-plan", reason: "none" };
      },
    });
    const ledger = openWorkLedger({ persist: openMemoryPersist(), now: () => 1_000 });
    await ledger.admit(feature());
    const conductor = openConductor({
      ledger,
      transformers,
      workLineStable: stable,
      workspaceRoot: root,
    });
    const result = await conductor.runProject("proj");
    assert.deepEqual(result, { outcome: "escalated", key: "fake:42" });
    assert.equal(
      calls.some((c) => c.op === "isolate"),
      false,
    );
    const got = await ledger.get("fake:42");
    assert.equal(got.ok && got.aggregate.state, "escalated");
  });

  it("5. implement escalated records attempts and keeps the child", async () => {
    const { stable, root } = tempPair();
    const subtaskPath = subtaskWorkspacePath(root, "fake:42", "A");
    const { transformers, calls } = recordingTransformers({
      async implement(input): Promise<ImplementResult> {
        if (input.id === "A") {
          return {
            outcome: "escalated",
            traces: [{ ended: "fail-blocking", report: "lint failed", refusedBy: "lint" }],
          };
        }
        return { outcome: "validated", traces: [{ ended: "validated" }] };
      },
    });
    const ledger = openWorkLedger({ persist: openMemoryPersist(), now: () => 1_000 });
    await ledger.admit(feature());
    const conductor = openConductor({
      ledger,
      transformers,
      workLineStable: stable,
      workspaceRoot: root,
    });
    const result = await conductor.runProject("proj");
    assert.deepEqual(result, { outcome: "escalated", key: "fake:42" });
    assert.equal(
      calls.some((c) => c.op === "integrate" && c.id === "A"),
      false,
    );
    assert.equal(existsSync(subtaskPath), true);
    const got = await ledger.get("fake:42");
    assert.equal(got.ok && got.aggregate.attempts.length, 1);
    assert.equal(got.ok && got.aggregate.attempts[0]?.trace?.ended, "fail-blocking");
    assert.equal(got.ok && got.aggregate.attempts[0]?.trace?.report, "lint failed");
    assert.equal(got.ok && got.aggregate.attempts[0]?.trace?.refusedBy, "lint");
    // The escalation carries the reason itself: a reader of the ledger is not
    // sent back to the attempts to learn why the feature froze.
    assert.equal(got.ok && got.aggregate.escalation?.report, "lint: lint failed");
  });

  it("6. subtask integrate conflict escalates and keeps the child", async () => {
    const { stable, root } = tempPair();
    const subtaskPath = subtaskWorkspacePath(root, "fake:42", "A");
    const { transformers } = recordingTransformers({
      async integrate(input) {
        if (input.id === "A") {
          return { outcome: "conflict" };
        }
        return { outcome: "integrated" };
      },
    });
    const ledger = openWorkLedger({ persist: openMemoryPersist(), now: () => 1_000 });
    await ledger.admit(feature());
    const conductor = openConductor({
      ledger,
      transformers,
      workLineStable: stable,
      workspaceRoot: root,
    });
    const result = await conductor.runProject("proj");
    assert.deepEqual(result, { outcome: "escalated", key: "fake:42" });
    assert.equal(existsSync(subtaskPath), true);
    const got = await ledger.get("fake:42");
    assert.equal(
      got.ok && got.aggregate.escalation?.report,
      "Folding A into the feature hit a conflict.",
    );
  });

  it("7. cancel of running destroys workspaces; cancel after merging is point-of-no-return", async () => {
    const { stable, root } = tempPair();
    const ledger = openWorkLedger({ persist: openMemoryPersist(), now: () => 1_000 });
    await ledger.admit(feature());
    const box: { pause?: () => void } = {};
    const { transformers } = recordingTransformers({
      async isolate(input) {
        mkdirSync(input.child, { recursive: true });
        if (input.child.endsWith("/feature")) {
          box.pause?.();
        }
        return { outcome: "isolated" };
      },
    });
    const conductor = openConductor({
      ledger,
      transformers,
      workLineStable: stable,
      workspaceRoot: root,
    });
    box.pause = () => conductor.pause();
    await conductor.runProject("proj");
    const featurePath = featureWorkspacePath(root, "fake:42");
    assert.equal(existsSync(featurePath), true);
    const cancelled = await conductor.cancel("fake:42");
    assert.deepEqual(cancelled, { ok: true });
    assert.equal(existsSync(featurePath), false);
    const got = await ledger.get("fake:42");
    assert.equal(got.ok && got.aggregate.state, "cancelled");

    const ledger2 = openWorkLedger({ persist: openMemoryPersist(), now: () => 1_000 });
    await ledger2.admit(feature({ key: "fake:merge" }));
    const { transformers: transformers2 } = recordingTransformers();
    const conductor2 = openConductor({
      ledger: ledger2,
      transformers: transformers2,
      workLineStable: stable,
      workspaceRoot: root,
    });
    await conductor2.runProject("proj");
    const afterDone = await ledger2.get("fake:merge");
    assert.equal(afterDone.ok && afterDone.aggregate.state, "done");
    const tooLate = await conductor2.cancel("fake:merge");
    assert.deepEqual(tooLate, { ok: false, code: "point-of-no-return" });
  });

  it("7b. a feature declared under an earlier layout keeps its workspace, and its kept Subtask is replaced", async () => {
    const { stable, root } = tempPair();
    const ledger = openWorkLedger({ persist: openMemoryPersist(), now: () => 1_000 });
    await ledger.admit(feature());
    // How workspaces were named before: encodeURIComponent of the key.
    const legacyFeature = join(root, "fake%3A42", "feature");
    const legacySubtask = join(root, "fake%3A42", "subtask-A");
    for (const dir of [legacyFeature, legacySubtask]) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(join(legacyFeature, "work.txt"), "kept");
    writeFileSync(join(legacySubtask, "stale.txt"), "gone");
    await ledger.declareWorkspace({
      key: "fake:42",
      feature: legacyFeature,
      subtask: legacySubtask,
    });
    const { transformers, calls } = recordingTransformers();
    const offered: string[] = [];
    const authority: AuthorityPort = {
      async submit(input) {
        offered.push(input.workspace);
        return { outcome: "submitted", reference: "r" };
      },
      async fold() {
        return { outcome: "folded" };
      },
    };
    const conductor = openConductor({
      ledger,
      transformers,
      workLineStable: stable,
      workspaceRoot: root,
      authority,
    });
    await conductor.runProject("proj");

    const featureAsked = featureWorkspacePath(root, "fake:42");
    assert.notEqual(featureAsked, legacyFeature);
    assert.equal(existsSync(featureAsked), false, "no second feature workspace is made");
    assert.equal(readFileSync(join(legacyFeature, "work.txt"), "utf8"), "kept");
    const isolations = calls.filter((c) => c.op === "isolate");
    assert.ok(isolations.every((c) => c.child !== featureAsked));
    const subtaskIsolation = isolations.find((c) => c.id === "fake:42:A");
    assert.equal(subtaskIsolation?.parent, legacyFeature);
    assert.equal(subtaskIsolation?.child, subtaskWorkspacePath(root, "fake:42", "A"));
    assert.equal(existsSync(legacySubtask), false, "the kept Subtask at the old path is replaced");
    assert.deepEqual(offered, [legacyFeature], "the Authority is told where the work is");
  });

  it("8. reconcile destroys undeclared directories under workspaceRoot, never WorkLineStable", async () => {
    const { stable, root } = tempPair();
    const orphan = join(root, "orphan");
    mkdirSync(orphan);
    writeFileSync(join(orphan, "x.txt"), "no");
    const ledger = openWorkLedger({ persist: openMemoryPersist(), now: () => 1_000 });
    const conductor = openConductor({
      ledger,
      transformers: recordingTransformers().transformers,
      workLineStable: stable,
      workspaceRoot: root,
    });
    await conductor.reconcile("proj");
    assert.equal(existsSync(orphan), false);
    assert.equal(existsSync(join(stable, "seed.txt")), true);
  });

  it("9. pause after feature isolate skips startSubtask", async () => {
    const { stable, root } = tempPair();
    const ledger = openWorkLedger({ persist: openMemoryPersist(), now: () => 1_000 });
    await ledger.admit(feature());
    const box: { pause?: () => void } = {};
    const { transformers, calls } = recordingTransformers({
      async isolate(input) {
        mkdirSync(input.child, { recursive: true });
        if (input.child.endsWith("/feature")) {
          box.pause?.();
        }
        return { outcome: "isolated" };
      },
    });
    const conductor = openConductor({
      ledger,
      transformers,
      workLineStable: stable,
      workspaceRoot: root,
    });
    box.pause = () => conductor.pause();
    const result = await conductor.runProject("proj");
    assert.equal(result.outcome, "paused");
    assert.equal(
      calls.some((c) => c.op === "implement" && c.id === "A"),
      false,
    );
    const got = await ledger.get("fake:42");
    assert.equal(got.ok && got.aggregate.state, "running");
  });

  function actingAuthority(calls: string[]): AuthorityPort {
    return {
      async submit(input) {
        calls.push(`submit ${input.ref} -> ${input.target}`);
        return { outcome: "submitted", reference: "ref-1" };
      },
      async fold() {
        calls.push("fold");
        return { outcome: "folded" };
      },
    };
  }

  it("offers the assembled feature instead of folding it itself", async () => {
    const { stable, root } = tempPair();
    const ledger = openWorkLedger({ persist: openMemoryPersist() });
    await ledger.admit(feature());
    const { transformers, calls } = recordingTransformers();
    const acted: string[] = [];
    const conductor = openConductor({
      ledger,
      transformers,
      workLineStable: stable,
      workspaceRoot: root,
      authority: actingAuthority(acted),
      workLineTarget: "dev",
    });

    const first = await conductor.runProject("proj");
    assert.equal(first.outcome, "paused");
    assert.deepEqual(acted, ["submit fake:42 -> dev"]);
    const got = await ledger.get("fake:42");
    assert.ok(got.ok);
    assert.equal(got.aggregate.state, "submitted");
    assert.equal(got.aggregate.submission?.reference, "ref-1");
    assert.equal(calls.filter((c) => c.op === "integrate" && c.parent === stable).length, 0);
  });

  it("keeps the Publisher's reason when the first offer is refused", async () => {
    const { stable, root } = tempPair();
    const ledger = openWorkLedger({ persist: openMemoryPersist() });
    await ledger.admit(feature());
    const { transformers } = recordingTransformers();
    const authority: AuthorityPort = {
      async submit() {
        return { outcome: "refused", reason: "git push rejected: non-fast-forward" };
      },
      async fold() {
        return { outcome: "folded" };
      },
    };
    const conductor = openConductor({
      ledger,
      transformers,
      workLineStable: stable,
      workspaceRoot: root,
      authority,
      workLineTarget: "dev",
    });

    const outcome = await conductor.runProject("proj");
    assert.equal(outcome.outcome, "escalated");
    const got = await ledger.get("fake:42");
    assert.ok(got.ok);
    assert.equal(got.aggregate.escalation?.kind, "submitted");
    // Discarding this reason left a person reading the escalation with
    // nothing but "refused" — no way to tell a push rejection from a dead API.
    assert.match(got.aggregate.escalation?.report ?? "", /non-fast-forward/);
  });

  it("judges what was published with Gates, and folds only on their word", async () => {
    const { stable, root } = tempPair();
    const ledger = openWorkLedger({ persist: openMemoryPersist() });
    await ledger.admit(feature());
    const judged: string[] = [];
    const { transformers, calls } = recordingTransformers({
      async implement(input) {
        judged.push(`${input.id} produce=${String(input.produce)}`);
        return { outcome: "validated", traces: [{ ended: "validated" }] };
      },
    });
    const acted: string[] = [];
    const conductor = openConductor({
      ledger,
      transformers,
      workLineStable: stable,
      workspaceRoot: root,
      authority: actingAuthority(acted),
      workLineTarget: "dev",
    });

    await conductor.runProject("proj");
    const done = await conductor.runProject("proj");
    assert.equal(done.outcome, "done");
    // The judgement makes nothing, and the fold is an action taken on its word.
    assert.ok(judged.includes("fake:42:judgement produce=false"), judged.join(" | "));
    assert.deepEqual(acted, ["submit fake:42 -> dev", "fold"]);
    assert.equal(calls.filter((c) => c.op === "integrate" && c.parent === stable).length, 0);
  });

  it("sends a Gate's refusal into the next round, on the same Submission", async () => {
    const { stable, root } = tempPair();
    const ledger = openWorkLedger({ persist: openMemoryPersist() });
    await ledger.admit(feature());
    const reports: (string | undefined)[] = [];
    let refuse = true;
    const { transformers } = recordingTransformers({
      async implement(input) {
        if (input.id.endsWith(":judgement")) {
          if (refuse) {
            return {
              outcome: "escalated",
              traces: [{ ended: "fail-retryable", report: "the check went red" }],
            };
          }
          return { outcome: "validated", traces: [{ ended: "validated" }] };
        }
        if (input.id.endsWith(":assembly")) {
          reports.push(input.report);
        }
        return { outcome: "validated", traces: [{ ended: "validated" }] };
      },
    });
    const conductor = openConductor({
      ledger,
      transformers,
      workLineStable: stable,
      workspaceRoot: root,
      authority: actingAuthority([]),
      workLineTarget: "dev",
    });

    await conductor.runProject("proj");
    await conductor.runProject("proj");
    const back = await ledger.get("fake:42");
    assert.ok(back.ok);
    assert.equal(back.aggregate.state, "integrating");
    assert.equal(back.aggregate.submission?.refusals, 1);

    refuse = false;
    await conductor.runProject("proj");
    // The next round produces, and what refused it is what it is given.
    assert.deepEqual(reports, ["the check went red"]);
  });

  it("produces the repair before the Integration that takes it up", async () => {
    const { stable, root } = tempPair();
    const ledger = openWorkLedger({ persist: openMemoryPersist() });
    await ledger.admit(feature());
    const order: string[] = [];
    let refuse = true;
    const { transformers } = recordingTransformers({
      async implement(input) {
        if (input.id.endsWith(":judgement")) {
          return refuse
            ? {
                outcome: "escalated",
                traces: [{ ended: "fail-retryable", report: "the check went red" }],
              }
            : { outcome: "validated", traces: [{ ended: "validated" }] };
        }
        if (input.id.endsWith(":assembly")) {
          order.push("produce");
        }
        return { outcome: "validated", traces: [{ ended: "validated" }] };
      },
      async integrate(input) {
        if (input.id.endsWith(":align")) {
          order.push("align");
        }
        return { outcome: "integrated" };
      },
    });
    const conductor = openConductor({
      ledger,
      transformers,
      workLineStable: stable,
      workspaceRoot: root,
      authority: actingAuthority([]),
      workLineTarget: "dev",
    });

    await conductor.runProject("proj");
    await conductor.runProject("proj");
    refuse = false;
    await conductor.runProject("proj");

    // A producer leaves its work loose in the workspace and the Integration is
    // the only thing that takes it up. Aligning first publishes the state that
    // was already refused, and the repair waits a whole round.
    const produced = order.indexOf("produce");
    assert.ok(produced >= 0, `no repair ran: ${order.join(", ")}`);
    assert.equal(order[produced + 1], "align", `order was ${order.join(", ")}`);
  });

  it("escalates on a blocking refusal without spending a round", async () => {
    const { stable, root } = tempPair();
    const ledger = openWorkLedger({ persist: openMemoryPersist() });
    await ledger.admit(feature());
    const { transformers } = recordingTransformers({
      async implement(input) {
        if (input.id.endsWith(":judgement")) {
          return {
            outcome: "escalated",
            traces: [{ ended: "fail-blocking", report: "nothing was published" }],
          };
        }
        return { outcome: "validated", traces: [{ ended: "validated" }] };
      },
    });
    const conductor = openConductor({
      ledger,
      transformers,
      workLineStable: stable,
      workspaceRoot: root,
      authority: actingAuthority([]),
      workLineTarget: "dev",
      maxRefusals: 3,
    });

    await conductor.runProject("proj");
    const outcome = await conductor.runProject("proj");
    assert.equal(outcome.outcome, "escalated");
    const got = await ledger.get("fake:42");
    assert.ok(got.ok);
    // No round is spent on a refusal another round cannot repair.
    assert.equal(got.aggregate.submission?.refusals, 0);
    assert.equal(got.aggregate.escalation?.kind, "submitted");
  });

  it("escalates when the work has been sent back too often", async () => {
    const { stable, root } = tempPair();
    const ledger = openWorkLedger({ persist: openMemoryPersist() });
    await ledger.admit(feature());
    const { transformers } = recordingTransformers({
      async implement(input) {
        if (input.id.endsWith(":judgement")) {
          return {
            outcome: "escalated",
            traces: [{ ended: "fail-retryable", report: "still red" }],
          };
        }
        return { outcome: "validated", traces: [{ ended: "validated" }] };
      },
    });
    const conductor = openConductor({
      ledger,
      transformers,
      workLineStable: stable,
      workspaceRoot: root,
      authority: actingAuthority([]),
      workLineTarget: "dev",
      maxRefusals: 2,
    });

    let outcome = "";
    for (let pass = 0; pass < 8 && outcome !== "escalated"; pass += 1) {
      outcome = (await conductor.runProject("proj")).outcome;
    }
    assert.equal(outcome, "escalated");
    const got = await ledger.get("fake:42");
    assert.ok(got.ok);
    assert.equal(got.aggregate.escalation?.kind, "submitted");
    // The refusal that stopped it is never recorded as one, so without this the
    // person who reads the escalation is told a Feature is frozen and no more.
    assert.match(got.aggregate.escalation?.report ?? "", /still red/);
  });

  it("tells the repair which check refused it", async () => {
    const { stable, root } = tempPair();
    const ledger = openWorkLedger({ persist: openMemoryPersist() });
    await ledger.admit(feature());
    const from: (string | undefined)[] = [];
    let refuse = true;
    const { transformers } = recordingTransformers({
      async implement(input) {
        if (input.id.endsWith(":judgement")) {
          return refuse
            ? {
                outcome: "escalated",
                traces: [
                  { ended: "fail-retryable", report: "the check went red", refusedBy: "ci-green" },
                ],
              }
            : { outcome: "validated", traces: [{ ended: "validated" }] };
        }
        if (input.id.endsWith(":assembly")) {
          from.push(input.reportFrom);
        }
        return { outcome: "validated", traces: [{ ended: "validated" }] };
      },
    });
    const conductor = openConductor({
      ledger,
      transformers,
      workLineStable: stable,
      workspaceRoot: root,
      authority: actingAuthority([]),
      workLineTarget: "dev",
    });

    await conductor.runProject("proj");
    await conductor.runProject("proj");
    refuse = false;
    await conductor.runProject("proj");
    assert.deepEqual(from, ["ci-green"]);
  });

  it("says an assembly escalated, not one of its Subtasks", async () => {
    const { stable, root } = tempPair();
    const ledger = openWorkLedger({ persist: openMemoryPersist() });
    await ledger.admit(feature());
    const { transformers } = recordingTransformers({
      async implement(input) {
        if (input.id.endsWith(":assembly") || input.id.endsWith(":judgement")) {
          return {
            outcome: "escalated",
            traces: [{ ended: "fail-blocking", report: "the whole thing", refusedBy: "npm-test" }],
          };
        }
        return { outcome: "validated", traces: [{ ended: "validated" }] };
      },
    });
    const conductor = openConductor({
      ledger,
      transformers,
      workLineStable: stable,
      workspaceRoot: root,
    });

    let outcome = "";
    for (let pass = 0; pass < 6 && outcome !== "escalated"; pass += 1) {
      outcome = (await conductor.runProject("proj")).outcome;
    }
    assert.equal(outcome, "escalated");
    const got = await ledger.get("fake:42");
    assert.ok(got.ok);
    // Naming a Subtask here sends a reader to look at work that did not fail.
    assert.equal(got.aggregate.escalation?.kind, "assembly");
    assert.equal(got.aggregate.escalation?.subtask_id, undefined);
    assert.match(got.aggregate.escalation?.report ?? "", /npm-test: the whole thing/);
  });

  it("will not rebuild a feature the Authority is already holding", async () => {
    const { stable, root } = tempPair();
    const ledger = openWorkLedger({ persist: openMemoryPersist() });
    await ledger.admit(feature());
    const { transformers, calls } = recordingTransformers();
    const authority: AuthorityPort = {
      async submit() {
        return { outcome: "submitted", reference: "ref-1" };
      },
      async fold() {
        return { outcome: "folded" };
      },
    };
    const conductor = openConductor({
      ledger,
      transformers,
      workLineStable: stable,
      workspaceRoot: root,
      authority,
      workLineTarget: "dev",
    });

    await conductor.runProject("proj");
    // The workspace goes away while the Authority still holds the Submission.
    rmSync(featureWorkspacePath(root, "fake:42"), { recursive: true, force: true });
    const isolatesBefore = calls.filter((c) => c.op === "isolate").length;

    const after = await conductor.runProject("proj");
    assert.equal(after.outcome, "escalated");
    assert.equal(
      calls.filter((c) => c.op === "isolate").length,
      isolatesBefore,
      "rebuilding would publish over what the Authority was shown",
    );
    const got = await ledger.get("fake:42");
    assert.ok(got.ok);
    assert.equal(got.aggregate.escalation?.kind, "submitted");
  });

  it("tells a watcher when the plan is in, a Subtask lands, and the work is submitted", async () => {
    const { stable, root } = tempPair();
    const ledger = openWorkLedger({ persist: openMemoryPersist() });
    await ledger.admit(feature());
    const { transformers } = recordingTransformers();
    const moments: ConductorMoment[] = [];
    const conductor = openConductor({
      ledger,
      transformers,
      workLineStable: stable,
      workspaceRoot: root,
      authority: {
        async submit() {
          return { outcome: "submitted", reference: "ref-1" };
        },
        async fold() {
          return { outcome: "folded" };
        },
      },
      workLineTarget: "dev",
      observe(moment) {
        moments.push(moment);
      },
    });

    await conductor.runProject("proj");

    assert.deepEqual(moments, [
      { kind: "planned", key: "fake:42" },
      { kind: "subtask-integrated", key: "fake:42", subtaskId: "A", integrated: 1, total: 1 },
      { kind: "submitted", key: "fake:42", reference: "ref-1" },
    ]);
  });

  it("does not let a watcher's failure stop the work", async () => {
    const { stable, root } = tempPair();
    const ledger = openWorkLedger({ persist: openMemoryPersist() });
    await ledger.admit(feature());
    const { transformers } = recordingTransformers();
    const conductor = openConductor({
      ledger,
      transformers,
      workLineStable: stable,
      workspaceRoot: root,
      observe() {
        throw new Error("the tracker is down");
      },
    });
    const result = await conductor.runProject("proj");
    assert.equal(result.outcome, "done");
  });

  it("says which situation each Task is judged in", async () => {
    const { stable, root } = tempPair();
    const ledger = openWorkLedger({ persist: openMemoryPersist() });
    await ledger.admit(feature());
    const stages: (string | undefined)[] = [];
    const { transformers } = recordingTransformers({
      async implement(input) {
        stages.push(input.stage);
        return { outcome: "validated", traces: [{ ended: "validated" }] };
      },
    });
    const conductor = openConductor({
      ledger,
      transformers,
      workLineStable: stable,
      workspaceRoot: root,
    });
    await conductor.runProject("proj");
    // A unit of work, then the feature they assemble into: two situations, and
    // whoever wires the Gates must be able to tell them apart.
    assert.deepEqual(stages, [undefined, "assembly"]);
  });

  it("judges the assembled feature without producing anything", async () => {
    const { stable, root } = tempPair();
    const ledger = openWorkLedger({ persist: openMemoryPersist() });
    await ledger.admit(feature());
    const produced: (boolean | undefined)[] = [];
    const { transformers } = recordingTransformers({
      async implement(input) {
        produced.push(input.produce);
        return { outcome: "validated", traces: [{ ended: "validated" }] };
      },
    });
    const conductor = openConductor({
      ledger,
      transformers,
      workLineStable: stable,
      workspaceRoot: root,
    });
    await conductor.runProject("proj");
    // The Subtask produces; the assembly of already-validated work does not.
    assert.deepEqual(produced, [undefined, false]);
  });

  it("a Planner that did not answer is unavailable, not transformer-invalid", async () => {
    const { stable, root } = tempPair();
    const { transformers } = recordingTransformers({
      async breakDown() {
        return { outcome: "unavailable" };
      },
    });
    const ledger = openWorkLedger({ persist: openMemoryPersist(), now: () => 1_000 });
    await ledger.admit(feature());
    const conductor = openConductor({
      ledger,
      transformers,
      workLineStable: stable,
      workspaceRoot: root,
    });
    const result = await conductor.runProject("proj");
    assert.deepEqual(result, { outcome: "refused", code: "unavailable" });
    const got = await ledger.get("fake:42");
    assert.equal(got.ok && got.aggregate.state, "planning");
    assert.equal(got.ok && got.aggregate.plan, undefined);
  });

  it("escalates after a Subtask when a newer fingerprint arrived in flight", async () => {
    const { stable, root } = tempPair();
    const ledger = openWorkLedger({ persist: openMemoryPersist(), now: () => 1_000 });
    await ledger.admit(feature());
    let pauseNow: (() => void) | undefined;
    const { transformers } = recordingTransformers({
      async isolate(input) {
        mkdirSync(input.child, { recursive: true });
        if (input.parent === stable) {
          pauseNow?.();
        }
        return { outcome: "isolated" };
      },
    });
    const conductor = openConductor({
      ledger,
      transformers,
      workLineStable: stable,
      workspaceRoot: root,
    });
    pauseNow = () => conductor.pause();
    const paused = await conductor.runProject("proj");
    assert.equal(paused.outcome, "paused");
    const admitted = await ledger.admit(feature({ fingerprint: "fp-2" }));
    assert.deepEqual(admitted, { ok: true });
    const mid = await ledger.get("fake:42");
    assert.equal(mid.ok && mid.aggregate.state, "running");
    assert.equal(mid.ok && mid.aggregate.pending_fingerprint, "fp-2");
    conductor.resume();
    const result = await conductor.runProject("proj");
    assert.deepEqual(result, { outcome: "escalated", key: "fake:42" });
    const got = await ledger.get("fake:42");
    assert.ok(got.ok);
    assert.equal(got.aggregate.state, "escalated");
    assert.equal(got.aggregate.escalation?.kind, "plan");
    assert.equal(got.aggregate.pending_fingerprint, undefined);
    assert.match(got.aggregate.escalation?.report ?? "", /fp-2/);
  });

  describe("assembly.validate", () => {
    it("is not called when the Project does not declare it", async () => {
      const { stable, root } = tempPair();
      const ledger = openWorkLedger({ persist: openMemoryPersist() });
      await ledger.admit(feature());
      const validateCalls: unknown[] = [];
      const { transformers } = recordingTransformers({
        async implement(input) {
          if (input.validate === true) {
            validateCalls.push(input);
          }
          return { outcome: "validated", traces: [{ ended: "validated" }] };
        },
      });
      const conductor = openConductor({
        ledger,
        transformers,
        workLineStable: stable,
        workspaceRoot: root,
      });
      const result = await conductor.runProject("proj");
      assert.equal(result.outcome, "done");
      assert.equal(validateCalls.length, 0);
    });

    it("runs after align and before the local judge, with no Authority", async () => {
      const { stable, root } = tempPair();
      const ledger = openWorkLedger({ persist: openMemoryPersist() });
      await ledger.admit(feature());
      const order: string[] = [];
      const { transformers } = recordingTransformers({
        async implement(input) {
          if (input.validate === true) {
            order.push("validate");
          } else if (input.id.endsWith(":judgement")) {
            order.push("judgement");
          }
          return { outcome: "validated", traces: [{ ended: "validated" }] };
        },
        async integrate(input) {
          if (input.id.endsWith(":align")) {
            order.push("align");
          }
          return { outcome: "integrated" };
        },
      });
      const conductor = openConductor({
        ledger,
        transformers,
        workLineStable: stable,
        workspaceRoot: root,
        assemblyValidate: true,
      });
      const result = await conductor.runProject("proj");
      assert.equal(result.outcome, "done");
      assert.deepEqual(order, ["align", "validate", "judgement"]);
    });

    it("runs after align and before offer, with an Authority", async () => {
      const { stable, root } = tempPair();
      const ledger = openWorkLedger({ persist: openMemoryPersist() });
      await ledger.admit(feature());
      const order: string[] = [];
      const { transformers } = recordingTransformers({
        async implement(input) {
          if (input.validate === true) {
            order.push("validate");
          }
          return { outcome: "validated", traces: [{ ended: "validated" }] };
        },
        async integrate(input) {
          if (input.id.endsWith(":align")) {
            order.push("align");
          }
          return { outcome: "integrated" };
        },
      });
      const acted: string[] = [];
      const authority: AuthorityPort = {
        async submit(input) {
          order.push("offer");
          acted.push(`submit ${input.ref}`);
          return { outcome: "submitted", reference: "ref-1" };
        },
        async fold() {
          return { outcome: "folded" };
        },
      };
      const conductor = openConductor({
        ledger,
        transformers,
        workLineStable: stable,
        workspaceRoot: root,
        authority,
        workLineTarget: "dev",
        assemblyValidate: true,
      });
      const result = await conductor.runProject("proj");
      assert.equal(result.outcome, "paused");
      assert.deepEqual(order, ["align", "validate", "offer"]);
      assert.deepEqual(acted, ["submit fake:42"]);
    });

    it("a refusal parks the report and repairs on the next pass, without offering", async () => {
      const { stable, root } = tempPair();
      const ledger = openWorkLedger({ persist: openMemoryPersist() });
      await ledger.admit(feature());
      let refuse = true;
      const fixed: (string | undefined)[] = [];
      const acted: string[] = [];
      const { transformers } = recordingTransformers({
        async implement(input) {
          if (input.validate === true) {
            return refuse
              ? {
                  outcome: "escalated",
                  traces: [
                    {
                      ended: "fail-retryable",
                      report: "drops the CLI flag",
                      refusedBy: "reviewer",
                    },
                  ],
                }
              : { outcome: "validated", traces: [{ ended: "validated" }] };
          }
          if (input.id.endsWith(":assembly")) {
            fixed.push(input.report);
          }
          return { outcome: "validated", traces: [{ ended: "validated" }] };
        },
      });
      const authority: AuthorityPort = {
        async submit(input) {
          acted.push(`submit ${input.ref}`);
          return { outcome: "submitted", reference: "ref-1" };
        },
        async fold() {
          return { outcome: "folded" };
        },
      };
      const conductor = openConductor({
        ledger,
        transformers,
        workLineStable: stable,
        workspaceRoot: root,
        authority,
        workLineTarget: "dev",
        assemblyValidate: true,
        assemblyFixDeclared: true,
      });

      const first = await conductor.runProject("proj");
      assert.equal(first.outcome, "paused");
      assert.deepEqual(acted, [], "not offered while validate refuses");
      const parked = await ledger.get("fake:42");
      assert.ok(parked.ok);
      assert.equal(parked.aggregate.state, "integrating");
      assert.equal(parked.aggregate.parked_refusal?.report, "drops the CLI flag");
      assert.equal(parked.aggregate.parked_refusal?.refused_by, "reviewer");
      assert.equal(parked.aggregate.parked_refusals, 1);

      refuse = false;
      const second = await conductor.runProject("proj");
      assert.equal(second.outcome, "paused");
      assert.deepEqual(fixed, ["drops the CLI flag"]);
      assert.deepEqual(acted, ["submit fake:42"]);
      const cleared = await ledger.get("fake:42");
      assert.ok(cleared.ok);
      assert.equal(cleared.aggregate.parked_refusal, undefined);
      assert.equal(cleared.aggregate.parked_refusals, 1);
    });

    it("escalates on the spot when no assembly.fix can repair it", async () => {
      const { stable, root } = tempPair();
      const ledger = openWorkLedger({ persist: openMemoryPersist() });
      await ledger.admit(feature());
      const { transformers } = recordingTransformers({
        async implement(input) {
          if (input.validate === true) {
            return {
              outcome: "escalated",
              traces: [{ ended: "fail-retryable", report: "needs a human call" }],
            };
          }
          return { outcome: "validated", traces: [{ ended: "validated" }] };
        },
      });
      const conductor = openConductor({
        ledger,
        transformers,
        workLineStable: stable,
        workspaceRoot: root,
        assemblyValidate: true,
        assemblyFixDeclared: false,
      });
      const result = await conductor.runProject("proj");
      assert.deepEqual(result, { outcome: "escalated", key: "fake:42" });
      const got = await ledger.get("fake:42");
      assert.ok(got.ok);
      assert.equal(got.aggregate.escalation?.kind, "assembly");
      assert.equal(got.aggregate.parked_refusal, undefined);
      assert.equal(got.aggregate.parked_refusals, undefined);
      assert.match(got.aggregate.escalation?.report ?? "", /needs a human call/);
    });

    it("escalates immediately on a blocking refusal, without parking", async () => {
      const { stable, root } = tempPair();
      const ledger = openWorkLedger({ persist: openMemoryPersist() });
      await ledger.admit(feature());
      const { transformers } = recordingTransformers({
        async implement(input) {
          if (input.validate === true) {
            return {
              outcome: "escalated",
              traces: [{ ended: "fail-blocking", report: "not usable" }],
            };
          }
          return { outcome: "validated", traces: [{ ended: "validated" }] };
        },
      });
      const conductor = openConductor({
        ledger,
        transformers,
        workLineStable: stable,
        workspaceRoot: root,
        assemblyValidate: true,
        assemblyFixDeclared: true,
      });
      const result = await conductor.runProject("proj");
      assert.deepEqual(result, { outcome: "escalated", key: "fake:42" });
      const got = await ledger.get("fake:42");
      assert.ok(got.ok);
      assert.equal(got.aggregate.parked_refusals, undefined);
    });

    it("shares the maxRefusals budget with the Authority's own refusals", async () => {
      const { stable, root } = tempPair();
      const ledger = openWorkLedger({ persist: openMemoryPersist() });
      await ledger.admit(feature());
      const { transformers } = recordingTransformers({
        async implement(input) {
          if (input.validate === true) {
            return {
              outcome: "escalated",
              traces: [{ ended: "fail-retryable", report: "still off" }],
            };
          }
          return { outcome: "validated", traces: [{ ended: "validated" }] };
        },
      });
      const authority: AuthorityPort = {
        async submit() {
          throw new Error("must not reach offer while validate keeps refusing");
        },
        async fold() {
          return { outcome: "folded" };
        },
      };
      const conductor = openConductor({
        ledger,
        transformers,
        workLineStable: stable,
        workspaceRoot: root,
        authority,
        workLineTarget: "dev",
        assemblyValidate: true,
        assemblyFixDeclared: true,
        maxRefusals: 2,
      });

      let outcome = "";
      for (let pass = 0; pass < 8 && outcome !== "escalated"; pass += 1) {
        outcome = (await conductor.runProject("proj")).outcome;
      }
      assert.equal(outcome, "escalated");
      const got = await ledger.get("fake:42");
      assert.ok(got.ok);
      assert.equal(got.aggregate.escalation?.kind, "assembly");
      // maxRefusals is 2: the first refusal is repaired (parked_refusals → 1),
      // and the second is the one that spends the budget — it escalates rather
      // than parking a report nothing will read.
      assert.equal(got.aggregate.parked_refusals, 1);
      assert.match(got.aggregate.escalation?.report ?? "", /still off/);
    });
  });

  it("implement interrupted releases the Subtask so the next run does not wait for the bail", async () => {
    const { stable, root } = tempPair();
    const { transformers } = recordingTransformers({
      async implement() {
        return { outcome: "interrupted", traces: [] };
      },
    });
    const ledger = openWorkLedger({ persist: openMemoryPersist(), now: () => 1_000 });
    await ledger.admit(feature());
    const conductor = openConductor({
      ledger,
      transformers,
      workLineStable: stable,
      workspaceRoot: root,
    });
    const result = await conductor.runProject("proj");
    assert.deepEqual(result, { outcome: "refused", code: "interrupted" });
    const got = await ledger.get("fake:42");
    assert.ok(got.ok);
    assert.equal(got.aggregate.state, "running");
    assert.equal(got.aggregate.bail, undefined);
    assert.equal(got.aggregate.attempts_used, 1);
    assert.equal(got.aggregate.plan?.subtasks.find((st) => st.id === "A")?.state, "runnable");
    assert.equal(got.aggregate.workspaces?.subtask, undefined);
    const featurePath = featureWorkspacePath(root, "fake:42");
    const subtaskPath = subtaskWorkspacePath(root, "fake:42", "A");
    assert.equal(existsSync(featurePath), true);
    assert.equal(existsSync(subtaskPath), false);
  });

  it("breakDown interrupted leaves planning and the bail", async () => {
    const { stable, root } = tempPair();
    const { transformers } = recordingTransformers({
      async breakDown() {
        return { outcome: "interrupted" };
      },
    });
    const ledger = openWorkLedger({ persist: openMemoryPersist(), now: () => 1_000 });
    await ledger.admit(feature());
    const conductor = openConductor({
      ledger,
      transformers,
      workLineStable: stable,
      workspaceRoot: root,
    });
    const result = await conductor.runProject("proj");
    assert.deepEqual(result, { outcome: "refused", code: "interrupted" });
    const got = await ledger.get("fake:42");
    assert.ok(got.ok);
    assert.equal(got.aggregate.state, "planning");
    assert.ok(got.aggregate.bail !== undefined);
  });

  it("release on integrating is illegal-transition and leaves the bail", async () => {
    const { stable, root } = tempPair();
    const { transformers } = recordingTransformers();
    const ledger = openWorkLedger({ persist: openMemoryPersist(), now: () => 1_000 });
    await ledger.admit(feature());
    await ledger.claim("proj");
    await ledger.recordPlan({
      key: "fake:42",
      plannedAt: "2026-01-01T00:00:00.000Z",
      subtasks: [{ id: "A", intention: "first", definition_of_done: "A done", depends_on: [] }],
    });
    await ledger.startSubtask({ key: "fake:42", subtaskId: "A" });
    await ledger.recordAttempt({
      key: "fake:42",
      subtaskId: "A",
      number: 1,
      trace: { ended: "validated" },
    });
    await ledger.markSubtaskIntegrated({ key: "fake:42", subtaskId: "A" });
    const before = await ledger.get("fake:42");
    assert.ok(before.ok);
    assert.equal(before.aggregate.state, "integrating");
    assert.ok(before.aggregate.bail !== undefined);

    const conductor = openConductor({
      ledger,
      transformers,
      workLineStable: stable,
      workspaceRoot: root,
    });
    assert.deepEqual(await conductor.release("fake:42"), {
      ok: false,
      code: "illegal-transition",
    });
    const after = await ledger.get("fake:42");
    assert.ok(after.ok);
    assert.equal(after.aggregate.state, "integrating");
    assert.deepEqual(after.aggregate.bail, before.aggregate.bail);
  });
});

describe("warm Feature", () => {
  it("runs after Feature Isolation and before any Subtask Isolation", async () => {
    const { stable, root } = tempPair();
    const ledger = openWorkLedger({ persist: openMemoryPersist() });
    await ledger.admit(feature());
    const order: string[] = [];
    const { transformers } = recordingTransformers({
      async isolate(input) {
        order.push(`isolate:${input.parent === stable ? "feature" : "subtask"}`);
        mkdirSync(input.child, { recursive: true });
        return { outcome: "isolated" };
      },
    });
    const conductor = openConductor({
      ledger,
      transformers,
      workLineStable: stable,
      workspaceRoot: root,
      warm: {
        durationMs: 1_000,
        async prepare({ workspace }) {
          order.push(`warm:${workspace}`);
          writeFileSync(join(workspace, "warmed.txt"), "ok\n");
          return { outcome: "warmed" };
        },
      },
    });
    const result = await conductor.runProject("proj");
    assert.equal(result.outcome, "done");
    assert.deepEqual(
      order.slice(0, 3),
      ["isolate:feature", `warm:${featureWorkspacePath(root, "fake:42")}`, "isolate:subtask"],
      "warm sits between Feature and Subtask Isolation",
    );
  });

  it("is skipped on later passes once it succeeded", async () => {
    const { stable, root } = tempPair();
    const ledger = openWorkLedger({ persist: openMemoryPersist() });
    await ledger.admit(feature());
    let warmCalls = 0;
    let pauseNow: (() => void) | undefined;
    const { transformers } = recordingTransformers({
      async isolate(input) {
        mkdirSync(input.child, { recursive: true });
        if (input.parent !== stable) {
          pauseNow?.();
        }
        return { outcome: "isolated" };
      },
    });
    const conductor = openConductor({
      ledger,
      transformers,
      workLineStable: stable,
      workspaceRoot: root,
      warm: {
        durationMs: 1_000,
        async prepare() {
          warmCalls += 1;
          return { outcome: "warmed" };
        },
      },
    });
    pauseNow = () => conductor.pause();
    const paused = await conductor.runProject("proj");
    assert.equal(paused.outcome, "paused");
    assert.equal(warmCalls, 1);
    conductor.resume();
    const second = await conductor.runProject("proj");
    assert.equal(second.outcome, "done");
    assert.equal(warmCalls, 1, "a warmed Feature is not prepared again");
  });

  it("refuses warm-failed and retries on the next runProject", async () => {
    const { stable, root } = tempPair();
    const ledger = openWorkLedger({ persist: openMemoryPersist() });
    await ledger.admit(feature());
    let warmCalls = 0;
    const { transformers } = recordingTransformers();
    const conductor = openConductor({
      ledger,
      transformers,
      workLineStable: stable,
      workspaceRoot: root,
      warm: {
        durationMs: 1_000,
        async prepare() {
          warmCalls += 1;
          return { outcome: warmCalls === 1 ? "failed" : "warmed" };
        },
      },
    });
    const first = await conductor.runProject("proj");
    assert.deepEqual(first, { outcome: "refused", code: "warm-failed" });
    assert.equal(warmCalls, 1);
    const second = await conductor.runProject("proj");
    assert.equal(second.outcome, "done");
    assert.equal(warmCalls, 2);
  });

  it("is not required: without warm, Subtasks still run", async () => {
    const { stable, root } = tempPair();
    const ledger = openWorkLedger({ persist: openMemoryPersist() });
    await ledger.admit(feature());
    const { transformers } = recordingTransformers();
    const conductor = openConductor({
      ledger,
      transformers,
      workLineStable: stable,
      workspaceRoot: root,
    });
    assert.equal((await conductor.runProject("proj")).outcome, "done");
  });
});
