import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { PersistencePort } from "@bluewombat/work-ledger";
import {
  type Aggregate,
  isFeatureAggregate,
  openWorkLedger,
  type Summary,
  type TicketAdmission,
  type TicketSummary,
} from "@bluewombat/work-ledger";
import type { AuthorityPort, ImplementResult, TransformerPort } from "../transformers/port.js";
import { type ConductorMoment, openConductor } from "./open-conductor.js";
import { ticketWorkspacePath } from "./paths.js";

function toSummary(stored: Aggregate): Summary {
  if (isFeatureAggregate(stored)) {
    throw new Error("a Feature is not stored by these tests");
  }
  const aggregate = stored;
  const summary: TicketSummary = {
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
  it("1. isolates the Ticket's workspace before the Builder runs", async () => {
    const { stable, root } = tempPair();
    const { transformers, calls } = recordingTransformers();
    const ledger = openWorkLedger({ persist: openMemoryPersist(), now: () => 1_000 });
    await ledger.admit(ticket());
    const conductor = openConductor({
      ledger,
      transformers,
      workLineStable: stable,
      workspaceRoot: root,
    });
    const result = await conductor.runProject("proj");
    assert.equal(result.outcome, "done");
    const ops = calls.map((c) => c.op);
    assert.equal(ops[0], "isolate");
    assert.equal(ops[1], "implement");
  });

  it("2. declareWorkspace is recorded before isolate of that path", async () => {
    const { stable, root } = tempPair();
    const ledger = openWorkLedger({ persist: openMemoryPersist(), now: () => 1_000 });
    await ledger.admit(ticket());
    const ticketPath = ticketWorkspacePath(root, "fake:42");
    let declared = false;
    const { transformers } = recordingTransformers({
      async isolate(input) {
        const got = await ledger.get("fake:42");
        assert.equal(got.ok, true);
        if (input.child === ticketPath) {
          declared = got.ok && got.aggregate.workspace === ticketPath;
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
    assert.equal(declared, true);
  });

  it("3. happy path: one isolate, the unit then the judgement, two integrates", async () => {
    const { stable, root } = tempPair();
    const { transformers, calls } = recordingTransformers();
    const ledger = openWorkLedger({ persist: openMemoryPersist(), now: () => 1_000 });
    await ledger.admit(ticket());
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
    assert.equal(calls.filter((c) => c.op === "isolate").length, 1);
    // Aligning with the work line takes up what the Builder made; the last fold
    // lands it.
    assert.equal(calls.filter((c) => c.op === "integrate").length, 2);
    // The unit produces; the assembled work is judged and makes nothing.
    // With no Authority that judgement is the only one it gets.
    // Between them, the unit's own checks again on the aligned work.
    const implements_ = calls.filter((c) => c.op === "implement");
    assert.equal(implements_.length, 3);
    assert.equal(implements_[0]?.id, "fake:42");
    assert.equal(implements_[1]?.id, "fake:42:recheck");
    assert.equal(implements_[2]?.id, "fake:42:judgement");
  });

  it("4. a failed Isolation refuses, holds no lease and never runs the Builder", async () => {
    const { stable, root } = tempPair();
    const { transformers, calls } = recordingTransformers({
      async isolate() {
        return { outcome: "failed" };
      },
    });
    const ledger = openWorkLedger({ persist: openMemoryPersist(), now: () => 1_000 });
    await ledger.admit(ticket());
    const conductor = openConductor({
      ledger,
      transformers,
      workLineStable: stable,
      workspaceRoot: root,
    });
    const result = await conductor.runProject("proj");
    assert.deepEqual(result, { outcome: "refused", code: "isolate-failed" });
    assert.equal(
      calls.some((c) => c.op === "implement"),
      false,
    );
    const got = await ledger.get("fake:42");
    assert.equal(got.ok && got.aggregate.state, "running");
    assert.equal(got.ok && got.aggregate.bail, undefined);
    assert.equal(got.ok && got.aggregate.attempts_used, 0);
  });

  it("5. implement escalated records attempts and keeps the workspace", async () => {
    const { stable, root } = tempPair();
    const ticketPath = ticketWorkspacePath(root, "fake:42");
    const { transformers, calls } = recordingTransformers({
      async implement(input): Promise<ImplementResult> {
        if (input.id === "fake:42") {
          return {
            outcome: "escalated",
            traces: [{ ended: "fail-blocking", report: "lint failed", refusedBy: "lint" }],
          };
        }
        return { outcome: "validated", traces: [{ ended: "validated" }] };
      },
    });
    const ledger = openWorkLedger({ persist: openMemoryPersist(), now: () => 1_000 });
    await ledger.admit(ticket());
    const conductor = openConductor({
      ledger,
      transformers,
      workLineStable: stable,
      workspaceRoot: root,
    });
    const result = await conductor.runProject("proj");
    assert.deepEqual(result, { outcome: "escalated", key: "fake:42" });
    assert.equal(
      calls.some((c) => c.op === "integrate"),
      false,
    );
    assert.equal(existsSync(ticketPath), true);
    const got = await ledger.get("fake:42");
    assert.equal(got.ok && got.aggregate.attempts.length, 1);
    assert.equal(got.ok && got.aggregate.attempts[0]?.trace?.ended, "fail-blocking");
    assert.equal(got.ok && got.aggregate.attempts[0]?.trace?.report, "lint failed");
    assert.equal(got.ok && got.aggregate.attempts[0]?.trace?.refusedBy, "lint");
    assert.equal(got.ok && got.aggregate.escalation?.kind, "unit");
    // The escalation carries the reason itself: a reader of the ledger is not
    // sent back to the attempts to learn why the Ticket froze.
    assert.equal(got.ok && got.aggregate.escalation?.report, "lint: lint failed");
  });

  it("6. a resumed unit starts over in a fresh workspace", async () => {
    const { stable, root } = tempPair();
    const ticketPath = ticketWorkspacePath(root, "fake:42");
    let implementations = 0;
    const { transformers } = recordingTransformers({
      async implement(input): Promise<ImplementResult> {
        if (input.id === "fake:42") {
          implementations += 1;
          if (implementations === 1) {
            writeFileSync(join(ticketPath, "half-done.txt"), "x");
            return {
              outcome: "escalated",
              traces: [{ ended: "fail-blocking", report: "no", refusedBy: "lint" }],
            };
          }
          assert.equal(existsSync(join(ticketPath, "half-done.txt")), false);
        }
        return { outcome: "validated", traces: [{ ended: "validated" }] };
      },
    });
    const ledger = openWorkLedger({ persist: openMemoryPersist(), now: () => 1_000 });
    await ledger.admit(ticket());
    const conductor = openConductor({
      ledger,
      transformers,
      workLineStable: stable,
      workspaceRoot: root,
    });
    assert.equal((await conductor.runProject("proj")).outcome, "escalated");
    assert.deepEqual(await ledger.resumeTicket("fake:42"), { ok: true });
    assert.equal((await conductor.runProject("proj")).outcome, "done");
    assert.equal(implementations, 2);
  });

  it("7. cancel of running destroys workspaces; cancel after merging is point-of-no-return", async () => {
    const { stable, root } = tempPair();
    const ledger = openWorkLedger({ persist: openMemoryPersist(), now: () => 1_000 });
    await ledger.admit(ticket());
    const box: { pause?: () => void } = {};
    const { transformers } = recordingTransformers({
      async isolate(input) {
        mkdirSync(input.child, { recursive: true });
        if (input.child.endsWith("/ticket")) {
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
    const ticketPath = ticketWorkspacePath(root, "fake:42");
    assert.equal(existsSync(ticketPath), true);
    const cancelled = await conductor.cancel("fake:42");
    assert.deepEqual(cancelled, { ok: true });
    assert.equal(existsSync(ticketPath), false);
    const got = await ledger.get("fake:42");
    assert.equal(got.ok && got.aggregate.state, "cancelled");

    const ledger2 = openWorkLedger({ persist: openMemoryPersist(), now: () => 1_000 });
    await ledger2.admit(ticket({ key: "fake:merge" }));
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

  it("7b. a workspace declared elsewhere keeps its path, and the unit is made there", async () => {
    const { stable, root } = tempPair();
    const ledger = openWorkLedger({ persist: openMemoryPersist(), now: () => 1_000 });
    await ledger.admit(ticket());
    const declaredPath = join(root, "elsewhere", "work");
    await ledger.declareWorkspace({ key: "fake:42", path: declaredPath });
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

    const asked = ticketWorkspacePath(root, "fake:42");
    assert.equal(existsSync(asked), false, "no second workspace is made");
    const isolations = calls.filter((c) => c.op === "isolate");
    assert.deepEqual(
      isolations.map((c) => c.child),
      [declaredPath],
    );
    assert.deepEqual(offered, [declaredPath], "the Authority is told where the work is");
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

  it("9. pause after isolate skips the Builder", async () => {
    const { stable, root } = tempPair();
    const ledger = openWorkLedger({ persist: openMemoryPersist(), now: () => 1_000 });
    await ledger.admit(ticket());
    const box: { pause?: () => void } = {};
    const { transformers, calls } = recordingTransformers({
      async isolate(input) {
        mkdirSync(input.child, { recursive: true });
        if (input.child.endsWith("/ticket")) {
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
      calls.some((c) => c.op === "implement"),
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

  it("offers the assembled ticket instead of folding it itself", async () => {
    const { stable, root } = tempPair();
    const ledger = openWorkLedger({ persist: openMemoryPersist() });
    await ledger.admit(ticket());
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

  it("offers a Ticket to the line it names, not the Project's", async () => {
    const { stable, root } = tempPair();
    const ledger = openWorkLedger({ persist: openMemoryPersist() });
    await ledger.admit(ticket({ line: "feature/7" }));
    const { transformers } = recordingTransformers();
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
    assert.deepEqual(acted, ["submit fake:42 -> feature/7"]);
  });

  it("keeps the Publisher's reason when the first offer is refused", async () => {
    const { stable, root } = tempPair();
    const ledger = openWorkLedger({ persist: openMemoryPersist() });
    await ledger.admit(ticket());
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
    await ledger.admit(ticket());
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

  describe("when the line moved on while the Submission waited", () => {
    function movingAuthority(
      calls: string[],
      answers: ("current" | "behind" | "unavailable")[],
    ): AuthorityPort {
      return {
        async submit(input) {
          calls.push(`submit ${input.ref}`);
          return { outcome: "submitted", reference: "ref-1" };
        },
        async behind() {
          const next = answers.shift() ?? "current";
          calls.push(`behind ${next}`);
          return next === "behind" ? { outcome: "behind", commits: 2 } : { outcome: next };
        },
        async fold() {
          calls.push("fold");
          return { outcome: "folded" };
        },
      };
    }

    it("aligns again and judges again, and folds only once the line has not moved", async () => {
      const { stable, root } = tempPair();
      const ledger = openWorkLedger({ persist: openMemoryPersist() });
      await ledger.admit(ticket());
      const acted: string[] = [];
      const ran: string[] = [];
      const { transformers } = recordingTransformers({
        async implement(input) {
          ran.push(input.id);
          return { outcome: "validated", traces: [{ ended: "validated" }] };
        },
        async integrate(input) {
          ran.push(input.id);
          return { outcome: "integrated" };
        },
      });
      const conductor = openConductor({
        ledger,
        transformers,
        workLineStable: stable,
        workspaceRoot: root,
        authority: movingAuthority(acted, ["behind", "current"]),
        workLineTarget: "dev",
      });

      let last = await conductor.runProject("proj");
      for (let pass = 0; pass < 6 && last.outcome !== "done"; pass += 1) {
        last = await conductor.runProject("proj");
      }
      assert.equal(last.outcome, "done");
      // Offered, judged, found behind: no fold. Aligned and offered again (the same
      // Submission), judged again, found current: fold.
      assert.deepEqual(acted, [
        "submit fake:42",
        "behind behind",
        "submit fake:42",
        "behind current",
        "fold",
      ]);
      assert.equal(ran.filter((id) => id === "fake:42:align").length, 2);
      assert.equal(ran.filter((id) => id === "fake:42:judgement").length, 2);
      // Nothing was refused, so no producer is asked to repair anything.
      assert.equal(ran.filter((id) => id === "fake:42:fix").length, 0);
    });

    it("does not fold while it cannot tell", async () => {
      const { stable, root } = tempPair();
      const ledger = openWorkLedger({ persist: openMemoryPersist() });
      await ledger.admit(ticket());
      const acted: string[] = [];
      const { transformers } = recordingTransformers();
      const conductor = openConductor({
        ledger,
        transformers,
        workLineStable: stable,
        workspaceRoot: root,
        authority: movingAuthority(acted, ["unavailable"]),
        workLineTarget: "dev",
      });

      await conductor.runProject("proj");
      const second = await conductor.runProject("proj");
      assert.equal(second.outcome, "paused");
      assert.equal(acted.includes("fold"), false);
      const got = await ledger.get("fake:42");
      assert.ok(got.ok);
      assert.equal(got.aggregate.state, "submitted");
    });

    it("escalates when the line keeps moving, instead of aligning forever", async () => {
      const { stable, root } = tempPair();
      const ledger = openWorkLedger({ persist: openMemoryPersist() });
      await ledger.admit(ticket());
      const acted: string[] = [];
      const { transformers } = recordingTransformers();
      const conductor = openConductor({
        ledger,
        transformers,
        workLineStable: stable,
        workspaceRoot: root,
        authority: movingAuthority(acted, ["behind", "behind", "behind", "behind"]),
        workLineTarget: "dev",
        maxRefusals: 1,
      });

      for (let pass = 0; pass < 8; pass += 1) {
        await conductor.runProject("proj");
        const got = await ledger.get("fake:42");
        if (got.ok && got.aggregate.state === "escalated") {
          break;
        }
      }
      const got = await ledger.get("fake:42");
      assert.ok(got.ok);
      assert.equal(got.aggregate.state, "escalated");
      assert.match(got.aggregate.escalation?.report ?? "", /line moved on/);
      assert.equal(acted.includes("fold"), false);
    });
  });

  it("sends a Gate's refusal into the next round, on the same Submission", async () => {
    const { stable, root } = tempPair();
    const ledger = openWorkLedger({ persist: openMemoryPersist() });
    await ledger.admit(ticket());
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
        if (input.id.endsWith(":fix")) {
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
    await ledger.admit(ticket());
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
        if (input.id.endsWith(":fix")) {
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
    await ledger.admit(ticket());
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
    await ledger.admit(ticket());
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
    // person who reads the escalation is told a Ticket is frozen and no more.
    assert.match(got.aggregate.escalation?.report ?? "", /still red/);
  });

  it("tells the repair which check refused it", async () => {
    const { stable, root } = tempPair();
    const ledger = openWorkLedger({ persist: openMemoryPersist() });
    await ledger.admit(ticket());
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
        if (input.id.endsWith(":fix")) {
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

  it("says an assembly escalated, not the unit", async () => {
    const { stable, root } = tempPair();
    const ledger = openWorkLedger({ persist: openMemoryPersist() });
    await ledger.admit(ticket());
    const { transformers } = recordingTransformers({
      async implement(input) {
        if (input.id.endsWith(":fix") || input.id.endsWith(":judgement")) {
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
    // Naming the unit here sends a reader to look at work that did not fail.
    assert.equal(got.aggregate.escalation?.kind, "assembly");
    assert.match(got.aggregate.escalation?.report ?? "", /npm-test: the whole thing/);
  });

  it("will not rebuild a ticket the Authority is already holding", async () => {
    const { stable, root } = tempPair();
    const ledger = openWorkLedger({ persist: openMemoryPersist() });
    await ledger.admit(ticket());
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
    rmSync(ticketWorkspacePath(root, "fake:42"), { recursive: true, force: true });
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

  it("tells a watcher when the work is submitted", async () => {
    const { stable, root } = tempPair();
    const ledger = openWorkLedger({ persist: openMemoryPersist() });
    await ledger.admit(ticket());
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

    assert.deepEqual(moments, [{ kind: "submitted", key: "fake:42", reference: "ref-1" }]);
  });

  it("does not let a watcher's failure stop the work", async () => {
    const { stable, root } = tempPair();
    const ledger = openWorkLedger({ persist: openMemoryPersist() });
    await ledger.admit(ticket());
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
    await ledger.admit(ticket());
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
    // The unit, then the work assembled (checked again, then judged): two
    // situations, and whoever wires the Gates must be able to tell them apart.
    assert.deepEqual(stages, [undefined, "ticket", "ticket"]);
  });

  it("judges the assembled ticket without producing anything", async () => {
    const { stable, root } = tempPair();
    const ledger = openWorkLedger({ persist: openMemoryPersist() });
    await ledger.admit(ticket());
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
    // The unit produces; the assembly of already-validated work does not.
    assert.deepEqual(produced, [undefined, false, false]);
  });

  it("escalates after the unit when a newer fingerprint arrived in flight", async () => {
    const { stable, root } = tempPair();
    const ledger = openWorkLedger({ persist: openMemoryPersist(), now: () => 1_000 });
    await ledger.admit(ticket());
    let pauseNow: (() => void) | undefined;
    const { transformers } = recordingTransformers({
      async isolate(input) {
        mkdirSync(input.child, { recursive: true });
        pauseNow?.();
        pauseNow = undefined;
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
    const admitted = await ledger.admit(ticket({ fingerprint: "fp-2" }));
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
    assert.equal(got.aggregate.escalation?.kind, "unit");
    assert.equal(got.aggregate.pending_fingerprint, undefined);
    assert.match(got.aggregate.escalation?.report ?? "", /fp-2/);
  });

  describe("assembly.validate", () => {
    it("is not called when the Project does not declare it", async () => {
      const { stable, root } = tempPair();
      const ledger = openWorkLedger({ persist: openMemoryPersist() });
      await ledger.admit(ticket());
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
      await ledger.admit(ticket());
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
        validate: true,
      });
      const result = await conductor.runProject("proj");
      assert.equal(result.outcome, "done");
      assert.deepEqual(order, ["align", "validate", "judgement"]);
    });

    it("runs after align and before offer, with an Authority", async () => {
      const { stable, root } = tempPair();
      const ledger = openWorkLedger({ persist: openMemoryPersist() });
      await ledger.admit(ticket());
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
        validate: true,
      });
      const result = await conductor.runProject("proj");
      assert.equal(result.outcome, "paused");
      assert.deepEqual(order, ["align", "validate", "offer"]);
      assert.deepEqual(acted, ["submit fake:42"]);
    });

    it("a refusal that nothing can repair stops the work and keeps who refused it", async () => {
      const { stable, root } = tempPair();
      const ledger = openWorkLedger({ persist: openMemoryPersist() });
      await ledger.admit(ticket());
      const { transformers } = recordingTransformers({
        async implement(input) {
          if (input.validate === true) {
            return {
              outcome: "escalated",
              traces: [
                { ended: "fail-blocking", report: "no test account", refusedBy: "reviewer" },
              ],
            };
          }
          return { outcome: "validated", traces: [{ ended: "validated" }] };
        },
      });
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
        validate: true,
        fixDeclared: true,
      });

      const result = await conductor.runProject("proj");
      assert.equal(result.outcome, "escalated");
      const got = await ledger.get("fake:42");
      assert.ok(got.ok);
      assert.equal(got.aggregate.escalation?.kind, "assembly");
      assert.equal(got.aggregate.escalation?.refused_by, "reviewer");
      assert.match(got.aggregate.escalation?.report ?? "", /reviewer: no test account/);
    });

    it("a refusal parks the report and repairs on the next pass, without offering", async () => {
      const { stable, root } = tempPair();
      const ledger = openWorkLedger({ persist: openMemoryPersist() });
      await ledger.admit(ticket());
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
          if (input.id.endsWith(":fix")) {
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
        validate: true,
        fixDeclared: true,
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
      await ledger.admit(ticket());
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
        validate: true,
        fixDeclared: false,
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
      await ledger.admit(ticket());
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
        validate: true,
        fixDeclared: true,
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
      await ledger.admit(ticket());
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
        validate: true,
        fixDeclared: true,
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

  it("implement interrupted releases the unit, and keeps its workspace, so the next run does not wait for the bail", async () => {
    const { stable, root } = tempPair();
    const { transformers } = recordingTransformers({
      async implement() {
        return { outcome: "interrupted", traces: [] };
      },
    });
    const ledger = openWorkLedger({ persist: openMemoryPersist(), now: () => 1_000 });
    await ledger.admit(ticket());
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
    assert.equal(got.aggregate.attempts_used, 0, "stopping Mason is not an Attempt");
    assert.equal(got.aggregate.workspace, ticketWorkspacePath(root, "fake:42"));
    assert.equal(existsSync(ticketWorkspacePath(root, "fake:42")), true, "what it made stays");
  });

  it("release on integrating is illegal-transition and leaves the bail", async () => {
    const { stable, root } = tempPair();
    const { transformers } = recordingTransformers();
    const ledger = openWorkLedger({ persist: openMemoryPersist(), now: () => 1_000 });
    await ledger.admit(ticket());
    await ledger.claim("proj");
    await ledger.recordAttempt({ key: "fake:42", number: 1, trace: { ended: "validated" } });
    await ledger.markIntegrating("fake:42");
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

describe("warm", () => {
  it("runs after Isolation and before the Builder", async () => {
    const { stable, root } = tempPair();
    const ledger = openWorkLedger({ persist: openMemoryPersist() });
    await ledger.admit(ticket());
    const order: string[] = [];
    const { transformers } = recordingTransformers({
      async isolate(input) {
        order.push("isolate");
        mkdirSync(input.child, { recursive: true });
        return { outcome: "isolated" };
      },
      async implement(input) {
        order.push(`implement:${input.id}`);
        return { outcome: "validated", traces: [{ ended: "validated" }] };
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
      ["isolate", `warm:${ticketWorkspacePath(root, "fake:42")}`, "implement:fake:42"],
      "warm sits between Isolation and the Builder",
    );
  });

  it("refuses warm-failed and retries on the next runProject", async () => {
    const { stable, root } = tempPair();
    const ledger = openWorkLedger({ persist: openMemoryPersist() });
    await ledger.admit(ticket());
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

  it("is not required: without warm, the unit still runs", async () => {
    const { stable, root } = tempPair();
    const ledger = openWorkLedger({ persist: openMemoryPersist() });
    await ledger.admit(ticket());
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

describe("openConductor corrective loops", () => {
  function authorityWith(acted: string[], folds: ("conflict" | "folded")[] = ["folded"]) {
    const queue = [...folds];
    return {
      async submit(input: { ref: string }) {
        acted.push(`submit ${input.ref}`);
        return { outcome: "submitted" as const, reference: "ref-1" };
      },
      async fold() {
        const next = queue.shift() ?? "folded";
        acted.push(`fold ${next}`);
        return next === "conflict"
          ? { outcome: "conflict" as const, reason: "base branch was modified" }
          : { outcome: "folded" as const };
      },
    };
  }

  async function runUntil(
    conductor: ReturnType<typeof openConductor>,
    stop: (outcome: string) => boolean,
  ): Promise<string> {
    let outcome = "";
    for (let pass = 0; pass < 12 && !stop(outcome); pass += 1) {
      outcome = (await conductor.runProject("proj")).outcome;
    }
    return outcome;
  }

  async function rechecksWith(options: {
    changed: boolean | undefined;
    refuseJudgementOnce?: boolean;
  }): Promise<{ outcome: string; rechecks: number }> {
    const { stable, root } = tempPair();
    const ledger = openWorkLedger({ persist: openMemoryPersist() });
    await ledger.admit(ticket());
    let rechecks = 0;
    let refused = false;
    const { transformers } = recordingTransformers({
      async integrate() {
        return options.changed === undefined
          ? { outcome: "integrated" }
          : { outcome: "integrated", changed: options.changed };
      },
      async implement(input) {
        if (input.id.endsWith(":recheck")) {
          rechecks += 1;
        }
        if (input.id.endsWith(":judgement") && options.refuseJudgementOnce && !refused) {
          refused = true;
          return {
            outcome: "escalated",
            traces: [{ ended: "fail-retryable", report: "ci red", refusedBy: "ci-green" }],
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
      authority: authorityWith([]),
      workLineTarget: "dev",
      fixDeclared: true,
      maxRefusals: 3,
    });
    const outcome = await runUntil(conductor, (o) => o === "done" || o === "escalated");
    return { outcome, rechecks };
  }

  it("skips the recheck when nothing was repaired and the line brought nothing in", async () => {
    const ran = await rechecksWith({ changed: false });
    assert.deepEqual(ran, { outcome: "done", rechecks: 0 });
  });

  it("rechecks when the line brought something in", async () => {
    const ran = await rechecksWith({ changed: true });
    assert.deepEqual(ran, { outcome: "done", rechecks: 1 });
  });

  it("rechecks when the fold cannot say whether it changed anything", async () => {
    const ran = await rechecksWith({ changed: undefined });
    assert.deepEqual(ran, { outcome: "done", rechecks: 1 });
  });

  it("rechecks after a fix even though the line brought nothing in", async () => {
    const ran = await rechecksWith({ changed: false, refuseJudgementOnce: true });
    assert.deepEqual(ran, { outcome: "done", rechecks: 1 });
  });

  it("sends a failed recheck to the fix, then checks again", async () => {
    const { stable, root } = tempPair();
    const ledger = openWorkLedger({ persist: openMemoryPersist() });
    await ledger.admit(ticket());
    let rechecks = 0;
    const fixed: { report?: string | undefined; from?: string | undefined }[] = [];
    const { transformers } = recordingTransformers({
      async implement(input) {
        if (input.id.endsWith(":recheck")) {
          rechecks += 1;
          return rechecks === 1
            ? {
                outcome: "escalated",
                traces: [
                  {
                    ended: "fail-retryable",
                    report: "TS2322: not assignable",
                    refusedBy: "typecheck",
                  },
                ],
              }
            : { outcome: "validated", traces: [{ ended: "validated" }] };
        }
        if (input.id.endsWith(":fix")) {
          fixed.push({ report: input.report, from: input.reportFrom });
        }
        return { outcome: "validated", traces: [{ ended: "validated" }] };
      },
    });
    const acted: string[] = [];
    const conductor = openConductor({
      ledger,
      transformers,
      workLineStable: stable,
      workspaceRoot: root,
      authority: authorityWith(acted),
      workLineTarget: "dev",
      fixDeclared: true,
      maxRefusals: 3,
    });
    const outcome = await runUntil(conductor, (o) => o === "done" || o === "escalated");
    assert.equal(outcome, "done");
    assert.equal(rechecks, 2);
    assert.deepEqual(fixed, [{ report: "TS2322: not assignable", from: "typecheck" }]);
    // Nothing reached the Authority before the checks passed.
    assert.equal(acted[0], "submit fake:42");
  });

  it("sends an align conflict to the fix instead of stopping", async () => {
    const { stable, root } = tempPair();
    const ledger = openWorkLedger({ persist: openMemoryPersist() });
    await ledger.admit(ticket());
    let aligns = 0;
    const reports: (string | undefined)[] = [];
    const { transformers } = recordingTransformers({
      async implement(input) {
        if (input.id.endsWith(":fix")) {
          reports.push(input.report);
        }
        return { outcome: "validated", traces: [{ ended: "validated" }] };
      },
      async integrate(input) {
        if (input.id.endsWith(":align")) {
          aligns += 1;
          return aligns === 1 ? { outcome: "conflict" } : { outcome: "integrated" };
        }
        return { outcome: "integrated" };
      },
    });
    const conductor = openConductor({
      ledger,
      transformers,
      workLineStable: stable,
      workspaceRoot: root,
      authority: authorityWith([]),
      workLineTarget: "dev",
      fixDeclared: true,
      maxRefusals: 3,
    });
    const outcome = await runUntil(conductor, (o) => o === "done" || o === "escalated");
    assert.equal(outcome, "done");
    assert.equal(aligns, 2);
    assert.equal(reports.length, 1);
    assert.match(reports[0] ?? "", /conflicts/);
  });

  it("turns a fold the Authority refuses into a new alignment", async () => {
    const { stable, root } = tempPair();
    const ledger = openWorkLedger({ persist: openMemoryPersist() });
    await ledger.admit(ticket());
    const ran: string[] = [];
    const { transformers } = recordingTransformers({
      async implement(input) {
        ran.push(input.id);
        return { outcome: "validated", traces: [{ ended: "validated" }] };
      },
      async integrate(input) {
        ran.push(input.id);
        return { outcome: "integrated" };
      },
    });
    const acted: string[] = [];
    const conductor = openConductor({
      ledger,
      transformers,
      workLineStable: stable,
      workspaceRoot: root,
      authority: authorityWith(acted, ["conflict", "folded"]),
      workLineTarget: "dev",
      fixDeclared: true,
      maxRefusals: 3,
    });
    const outcome = await runUntil(conductor, (o) => o === "done" || o === "escalated");
    assert.equal(outcome, "done");
    assert.deepEqual(
      acted.filter((a) => a.startsWith("fold")),
      ["fold conflict", "fold folded"],
    );
    assert.equal(ran.filter((id) => id === "fake:42:align").length, 2);
    assert.equal(ran.filter((id) => id === "fake:42:recheck").length, 2);
  });

  it("stops for a person when nothing can fix a failed recheck", async () => {
    const { stable, root } = tempPair();
    const ledger = openWorkLedger({ persist: openMemoryPersist() });
    await ledger.admit(ticket());
    const { transformers } = recordingTransformers({
      async implement(input) {
        return input.id.endsWith(":recheck")
          ? {
              outcome: "escalated",
              traces: [{ ended: "fail-retryable", report: "tests red", refusedBy: "tests" }],
            }
          : { outcome: "validated", traces: [{ ended: "validated" }] };
      },
    });
    const conductor = openConductor({
      ledger,
      transformers,
      workLineStable: stable,
      workspaceRoot: root,
      authority: authorityWith([]),
      workLineTarget: "dev",
      // no fix declared
    });
    const outcome = await runUntil(conductor, (o) => o === "done" || o === "escalated");
    assert.equal(outcome, "escalated");
    const got = await ledger.get("fake:42");
    assert.ok(got.ok);
    assert.equal(got.aggregate.escalation?.kind, "assembly");
    assert.match(got.aggregate.escalation?.report ?? "", /tests: tests red/);
  });

  it("draws every loop on one budget: a recheck fixed once leaves less for the next refusal", async () => {
    const { stable, root } = tempPair();
    const ledger = openWorkLedger({ persist: openMemoryPersist() });
    await ledger.admit(ticket());
    let rechecks = 0;
    const { transformers } = recordingTransformers({
      async implement(input) {
        if (input.id.endsWith(":recheck")) {
          rechecks += 1;
          return rechecks === 1
            ? { outcome: "escalated", traces: [{ ended: "fail-retryable", report: "first" }] }
            : { outcome: "validated", traces: [{ ended: "validated" }] };
        }
        if (input.id.endsWith(":judgement")) {
          return { outcome: "escalated", traces: [{ ended: "fail-retryable", report: "CI red" }] };
        }
        return { outcome: "validated", traces: [{ ended: "validated" }] };
      },
    });
    const conductor = openConductor({
      ledger,
      transformers,
      workLineStable: stable,
      workspaceRoot: root,
      authority: authorityWith([]),
      workLineTarget: "dev",
      fixDeclared: true,
      maxRefusals: 2,
    });
    const outcome = await runUntil(conductor, (o) => o === "done" || o === "escalated");
    // One round went to the recheck, so the first refusal after publishing is already
    // the last one the budget allows.
    assert.equal(outcome, "escalated");
    const got = await ledger.get("fake:42");
    assert.ok(got.ok);
    assert.equal(got.aggregate.escalation?.kind, "submitted");
    assert.match(got.aggregate.escalation?.report ?? "", /CI red/);
  });
});

describe("openConductor with several Tickets at once", () => {
  function pair(): { stable: string; root: string } {
    return tempPair();
  }

  async function runToEnd(
    conductor: ReturnType<typeof openConductor>,
    key: string,
  ): Promise<string> {
    let outcome = "";
    for (let pass = 0; pass < 12 && outcome !== "done" && outcome !== "escalated"; pass += 1) {
      outcome = (await conductor.runTicket(key)).outcome;
    }
    return outcome;
  }

  const authority = {
    async submit(input: { ref: string }) {
      return { outcome: "submitted" as const, reference: `ref-${input.ref}` };
    },
    async fold() {
      return { outcome: "folded" as const };
    },
  };

  function instrumented() {
    const stats = { units: 0, mostUnits: 0, onLine: 0, mostOnLine: 0, refreshed: [] as string[] };
    const nap = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 15));
    const onLine = async <T>(job: () => Promise<T>): Promise<T> => {
      stats.onLine += 1;
      stats.mostOnLine = Math.max(stats.mostOnLine, stats.onLine);
      try {
        await nap();
        return await job();
      } finally {
        stats.onLine -= 1;
      }
    };
    const { transformers } = recordingTransformers({
      async isolate(input) {
        return await onLine(async () => {
          mkdirSync(input.child, { recursive: true });
          return { outcome: "isolated" as const };
        });
      },
      async integrate() {
        return await onLine(async () => ({ outcome: "integrated" as const }));
      },
      async implement(input) {
        if (/:(recheck|judgement|assembly|validate)$/.test(input.id)) {
          return { outcome: "validated", traces: [{ ended: "validated" }] };
        }
        stats.units += 1;
        stats.mostUnits = Math.max(stats.mostUnits, stats.units);
        await nap();
        await nap();
        stats.units -= 1;
        return { outcome: "validated", traces: [{ ended: "validated" }] };
      },
    });
    const line = {
      async refresh(target: string) {
        stats.refreshed.push(target);
        return { ok: true as const };
      },
    };
    return { stats, transformers, line };
  }

  it("works on two Tickets together, one at a time on the shared line", async () => {
    const { stable, root } = pair();
    const ledger = openWorkLedger({ persist: openMemoryPersist() });
    await ledger.admit(ticket({ key: "fake:1", fingerprint: "fp-1" }));
    await ledger.admit(ticket({ key: "fake:2", fingerprint: "fp-2" }));
    const { stats, transformers, line } = instrumented();
    const conductor = openConductor({
      ledger,
      transformers,
      workLineStable: stable,
      workspaceRoot: root,
      authority,
      workLineTarget: "dev",
      maxParallel: 2,
      line,
    });
    const first = await conductor.claimNext("proj");
    const second = await conductor.claimNext("proj");
    assert.deepEqual([first?.key, second?.key], ["fake:1", "fake:2"]);
    assert.equal(await conductor.claimNext("proj"), undefined);

    const ended = await Promise.all([runToEnd(conductor, "fake:1"), runToEnd(conductor, "fake:2")]);

    assert.deepEqual(ended, ["done", "done"]);
    assert.equal(stats.mostUnits, 2, "both units ran at the same time");
    assert.equal(stats.mostOnLine, 1, "the shared line was never used by two at once");
    // Each Ticket's line is refreshed before it is cut and before it is aligned.
    assert.deepEqual(stats.refreshed, ["dev", "dev", "dev", "dev"]);
  });

  it("starts a dependent Ticket only after the one it waits on has landed", async () => {
    const { stable, root } = pair();
    const ledger = openWorkLedger({ persist: openMemoryPersist() });
    await ledger.admit(ticket({ key: "fake:a", fingerprint: "fp-a" }));
    await ledger.admit(
      ticket({ key: "fake:c", fingerprint: "fp-c", priority: 99, blocked_by: ["fake:a"] }),
    );
    const { transformers, line } = instrumented();
    const conductor = openConductor({
      ledger,
      transformers,
      workLineStable: stable,
      workspaceRoot: root,
      authority,
      workLineTarget: "dev",
      maxParallel: 3,
      line,
    });
    assert.equal((await conductor.claimNext("proj"))?.key, "fake:a");
    assert.equal(await conductor.claimNext("proj"), undefined);
    assert.equal(await runToEnd(conductor, "fake:a"), "done");
    assert.equal((await conductor.claimNext("proj"))?.key, "fake:c");
  });

  it("refuses to start a Ticket when the line cannot be brought up to date", async () => {
    const { stable, root } = pair();
    const ledger = openWorkLedger({ persist: openMemoryPersist() });
    await ledger.admit(ticket());
    const { transformers } = instrumented();
    const conductor = openConductor({
      ledger,
      transformers,
      workLineStable: stable,
      workspaceRoot: root,
      authority,
      workLineTarget: "dev",
      line: { refresh: async () => ({ ok: false as const }) },
    });
    const key = (await conductor.claimNext("proj"))?.key ?? "";
    assert.deepEqual(await conductor.runTicket(key), {
      outcome: "refused",
      code: "line-refresh-failed",
    });
  });
});

describe("openConductor picks up a pass that was stopped", () => {
  type Implemented = {
    id: string;
    stage?: string;
    report?: string;
    reportFrom?: string;
    firstAttempt?: number;
    workspace: string;
  };

  function setup(implementations: Array<(input: Implemented) => ImplementResult>) {
    const { stable, root } = tempPair();
    const ledger = openWorkLedger({ persist: openMemoryPersist(), now: () => 1_000 });
    const implemented: Implemented[] = [];
    const isolated: string[] = [];
    const { transformers } = recordingTransformers({
      async isolate(input) {
        isolated.push(input.child);
        mkdirSync(input.child, { recursive: true });
        return { outcome: "isolated" };
      },
      async implement(input) {
        implemented.push(input as Implemented);
        const next = implementations.shift();
        return next === undefined
          ? { outcome: "validated", traces: [{ ended: "validated" }] }
          : next(input as Implemented);
      },
    });
    const conductor = openConductor({
      ledger,
      transformers,
      workLineStable: stable,
      workspaceRoot: root,
    });
    return { ledger, conductor, root, implemented, isolated };
  }

  const stopped = (input: Implemented): ImplementResult => {
    writeFileSync(join(input.workspace, "half-done.txt"), "wip");
    return { outcome: "interrupted", traces: [{ ended: "interrupted" }] };
  };

  it("r1. picks up the workspace instead of isolating again, and says so to the producer", async () => {
    let kept = "";
    const { ledger, conductor, root, implemented, isolated } = setup([
      stopped,
      (input) => {
        kept = readFileSync(join(input.workspace, "half-done.txt"), "utf8");
        return { outcome: "validated", traces: [{ ended: "validated" }] };
      },
    ]);
    await ledger.admit(ticket());
    await conductor.runProject("proj");
    const path = ticketWorkspacePath(root, "fake:42");
    assert.deepEqual(isolated, [path]);

    const again = await conductor.runProject("proj");
    assert.equal(again.outcome, "done");
    assert.deepEqual(isolated, [path], "no second isolation");
    assert.equal(kept, "wip");
    assert.match(implemented[1]?.report ?? "", /stopped before it finished/);
    assert.equal(implemented[1]?.firstAttempt, undefined);
  });

  it("r2. keeps the Attempts the stopped pass finished, and the next one goes on from them", async () => {
    const { ledger, conductor, implemented } = setup([
      (input) => {
        writeFileSync(join(input.workspace, "half-done.txt"), "wip");
        return {
          outcome: "interrupted",
          traces: [
            { ended: "fail-retryable", report: "3 tests fail", refusedBy: "tests" },
            { ended: "interrupted" },
          ],
        };
      },
    ]);
    await ledger.admit(ticket());
    await conductor.runProject("proj");
    const got = await ledger.get("fake:42");
    assert.ok(got.ok);
    assert.equal(got.aggregate.attempts.length, 1, "the interrupted Attempt is not one");
    assert.equal(got.aggregate.attempts_used, 1);

    await conductor.runProject("proj");
    assert.equal(implemented[1]?.firstAttempt, 2);
    assert.equal(implemented[1]?.report, "3 tests fail", "the producer gets what refused it");
    assert.equal(implemented[1]?.reportFrom, "tests");
  });

  it("r3. starts from zero when the workspace is gone", async () => {
    const { ledger, conductor, root, implemented, isolated } = setup([stopped]);
    await ledger.admit(ticket());
    await conductor.runProject("proj");
    rmSync(ticketWorkspacePath(root, "fake:42"), { recursive: true, force: true });

    await conductor.runProject("proj");
    assert.equal(isolated.length, 2);
    assert.equal(implemented[1]?.report, undefined);
  });

  it("r4. release is the way to start over: the workspace is dropped, not picked up", async () => {
    const { ledger, conductor, root, implemented, isolated } = setup([stopped]);
    await ledger.admit(ticket());
    await conductor.runProject("proj");
    const path = ticketWorkspacePath(root, "fake:42");

    assert.deepEqual(await conductor.release("fake:42"), { ok: true });
    assert.equal(existsSync(path), false);
    const got = await ledger.get("fake:42");
    assert.ok(got.ok);
    assert.equal(got.aggregate.workspace, undefined);

    await conductor.runProject("proj");
    assert.equal(isolated.length, 2);
    assert.equal(existsSync(join(path, "half-done.txt")), false);
    assert.equal(implemented[1]?.report, undefined);
  });
});
