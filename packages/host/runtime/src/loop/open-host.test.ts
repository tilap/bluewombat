import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { GateSpec } from "@bluewombat/implementer";
import type { HostOptions } from "../config/types.js";
import { cursorPath } from "./cursor.js";
import { openHost } from "./open-host.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures");
const node = process.execPath;
const SEED = "already good\n";
const MARKER = "work done\n";
const FEATURE = "fake:F1";
const KEY = "fake:42";

type Paths = {
  source: string;
  emitterTarget: string;
  workLineStable: string;
  workspaceRoot: string;
  ledgerRoot: string;
};

function sandbox(): Paths {
  const root = mkdtempSync(join(tmpdir(), "host-"));
  const workLineStable = join(root, "stable");
  mkdirSync(workLineStable);
  writeFileSync(join(workLineStable, "seed.txt"), SEED);
  const source = join(root, "source");
  const emitterTarget = join(root, "threads");
  mkdirSync(source);
  mkdirSync(emitterTarget);
  return {
    source,
    emitterTarget,
    workLineStable,
    workspaceRoot: join(root, "workspaces"),
    ledgerRoot: join(root, "ledger"),
  };
}

function publish(source: string, name: string, body: Record<string, unknown>): void {
  writeFileSync(join(source, name), JSON.stringify(body));
}

type TicketBody = Record<string, unknown> & { id: string };

/** A Feature as a file of the Source, its Tickets inside it. */
function convertible(
  id = "F1",
  over: Record<string, unknown> = {},
  tickets: TicketBody[] = [{ id: "42", intention: "deliver the marker file" }],
): Record<string, unknown> {
  return {
    id,
    project: "proj",
    intention: "a feature",
    priority: 75,
    // A Ticket with no words is not a Ticket: these say the marker file.
    tickets: tickets.map((ticket) => ({ intention: "deliver the marker file", ...ticket })),
    ...over,
  };
}

function passingGates(): GateSpec[] {
  return [{ id: "check", argv: [node, join(fixtures, "gate-pass.mjs")], timeoutMs: 10_000 }];
}

function blockingGates(): GateSpec[] {
  return [
    { id: "check", argv: [node, join(fixtures, "gate-fail-blocking.mjs")], timeoutMs: 10_000 },
  ];
}

function builder(): string[] {
  return [node, join(fixtures, "builder-write-marker.mjs")];
}

type Row = { event: string; key?: string; event_id?: string };

function threadRows(target: string, key: string): Row[] {
  const files = readdirSync(target).filter((name) => name.endsWith(".ndjson"));
  for (const name of files) {
    const body = readFileSync(join(target, name), "utf8").trim();
    if (body.length === 0) {
      continue;
    }
    const rows = body.split("\n").map((line) => JSON.parse(line) as Row);
    if (rows.some((row) => row.key === key)) {
      return rows;
    }
  }
  assert.fail(`no Thread for ${key}`);
}

function threadEvents(target: string, key: string): string[] {
  return threadRows(target, key).map((row) => row.event);
}

function journalEvents(ledgerRoot: string): Record<string, unknown>[] {
  return readFileSync(join(ledgerRoot, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Whether any Thread was ever opened. */
function hasThreads(target: string): boolean {
  return readdirSync(target).some((name) => name.endsWith(".ndjson"));
}

async function hostFor(paths: Paths, gates: GateSpec[], over: Partial<HostOptions> = {}) {
  return await openHost({
    ...over,
    featureTracker: {
      package: "@bluewombat/manager-fake",
      options: { source: paths.source, target: paths.emitterTarget },
    },
    ticketTracker: {
      package: "@bluewombat/manager-fake",
      options: { source: paths.source, target: paths.emitterTarget },
    },
    workLineStable: paths.workLineStable,
    workLineIsolation: "@bluewombat/isolation-copy",
    workspaceRoot: paths.workspaceRoot,
    ledgerRoot: paths.ledgerRoot,
    builder: {
      producer: { cmd: builder(), timeoutMs: 30_000, gates },
      repair: { cmd: builder(), timeoutMs: 30_000, gates: [] },
    },
    ticket: { gates: [] },
    timeoutMs: 30_000,
  });
}

describe("host", () => {
  it("0. one whole pass: every line names its run and its ticket, and the children are filmed", async () => {
    const paths = sandbox();
    const streamsDir = join(dirname(paths.ledgerRoot), "streams");
    publish(paths.source, "0001-create.json", convertible());
    const host = await hostFor(paths, passingGates(), {
      observability: { streams: { enabled: true, dir: streamsDir, keep: ["stdout", "stderr"] } },
    });
    const tick = await host.runOnce();
    await host.close();
    assert.equal(tick.lastRun?.outcome, "done");

    const lines = journalEvents(paths.ledgerRoot);

    // One run, named on every line, opened and closed.
    const runIds = new Set(lines.map((line) => line.run_id));
    assert.equal(runIds.size, 1);
    assert.equal(typeof [...runIds][0], "string");
    assert.equal(lines[0]?.event, "host-started");
    assert.equal(lines.at(-1)?.event, "host-stopped");

    // Every line about a Task says which ticket it served.
    const orphans = lines.filter(
      (line) =>
        (line.task_id !== undefined || line.id !== undefined) &&
        line.key === undefined &&
        line.event !== "host-started",
    );
    assert.deepEqual(orphans, [], "a line about a Task that cannot be joined to its ticket");
    for (const event of ["status", "attempt-started", "gate-finished", "isolation-started"]) {
      const found = lines.find((line) => line.event === event);
      assert.equal(found?.key, KEY, `${event} names the ticket`);
    }

    // The children were filmed, and the journal names the files.
    const opened = lines.filter((line) => line.event === "stream-opened");
    assert.ok(opened.length >= 1, "the Builder was filmed");
    assert.equal(
      opened.every((line) => line.key === KEY),
      true,
    );

    // What each file held outlives the file: the summary is written on close.
    const closed = lines.filter((line) => line.event === "stream-closed");
    assert.equal(closed.length, opened.length, "every film says what it held");
    assert.ok(
      closed.some((line) => Number(line.bytes) > 0 && Number(line.chunks) > 0),
      "at least one child actually said something",
    );

    // The ticket landed, so nobody has to read them: the bytes are gone and
    // the film says how much there was.
    const dropped = lines.find((line) => line.event === "streams-discarded");
    assert.equal(dropped?.key, KEY);
    assert.ok(Number(dropped?.files) > 0 && Number(dropped?.bytes) > 0);
    assert.equal(existsSync(join(streamsDir, "fake-42")), false);
  });

  it("1. convertible Feature: marker on WorkLineStable, both Threads told, Cursor saved", async () => {
    const paths = sandbox();
    publish(paths.source, "0001-create.json", convertible());
    const host = await hostFor(paths, passingGates());
    const tick = await host.runOnce();
    assert.equal(tick.lastRun?.outcome, "done");
    assert.deepEqual(tick.reported, ["accepted", "accepted", "done", "progress", "done"]);
    assert.equal(tick.cursor, "0001-create.json");
    assert.equal(readFileSync(join(paths.workLineStable, "delivered.txt"), "utf8"), MARKER);
    assert.equal(readFileSync(cursorPath(paths.ledgerRoot), "utf8").trim(), "0001-create.json");
    assert.deepEqual(threadEvents(paths.emitterTarget, FEATURE), ["accepted", "progress", "done"]);
    assert.deepEqual(threadEvents(paths.emitterTarget, KEY), ["accepted", "done"]);
    const feature = await host.ledger.getFeature(FEATURE);
    assert.equal(feature.ok && feature.aggregate.state, "done");
    const ticket = await host.ledger.get(KEY);
    assert.equal(ticket.ok && ticket.aggregate.state, "done");
    assert.equal(ticket.ok && ticket.aggregate.intention.feature, FEATURE);
    const events = journalEvents(paths.ledgerRoot).map((line) => line.event);
    for (const event of ["listen", "feature-opened", "status", "gate-finished", "reported"]) {
      assert.equal(events.includes(event), true, event);
    }
  });

  it("1b. the ledger lands where the persist backend a config names puts it", async () => {
    const paths = sandbox();
    publish(paths.source, "0001-create.json", convertible());
    const host = await hostFor(paths, passingGates(), { persist: "@bluewombat/persist-sqlite" });
    const tick = await host.runOnce();
    assert.equal(tick.lastRun?.outcome, "done");
    // The Feature and its Ticket are in SQLite, and nowhere else under the ledger root.
    assert.ok(existsSync(join(paths.ledgerRoot, "ledger.sqlite")));
    assert.equal(
      readdirSync(paths.ledgerRoot).some((name) => name.endsWith(".json")),
      false,
    );
    const listed = await host.ledger.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.state, "done");
    const features = await host.ledger.listFeatures();
    assert.equal(features.length, 1);
    assert.equal(features[0]?.state, "done");
    // Host's own files still sit beside it: the backend owns the bytes, not the root.
    assert.equal(readFileSync(cursorPath(paths.ledgerRoot), "utf8").trim(), "0001-create.json");
    assert.ok(existsSync(join(paths.ledgerRoot, "events.jsonl")));
  });

  it("2. invalid Feature: told once, nothing admitted, Cursor advanced, seed-only", async () => {
    const paths = sandbox();
    publish(paths.source, "0001-create.json", { id: "F1", project: "proj" });
    const host = await hostFor(paths, passingGates());
    const tick = await host.runOnce();
    assert.equal(tick.lastRun, undefined);
    assert.deepEqual(tick.reported, ["invalid"]);
    assert.equal((await host.ledger.getFeature(FEATURE)).ok, false);
    assert.equal(existsSync(join(paths.workLineStable, "delivered.txt")), false);
    assert.equal(tick.cursor, "0001-create.json");
  });

  it("3. a Ticket escalates, its tracker says resume, it resumes and the Feature is done", async () => {
    const paths = sandbox();
    publish(paths.source, "0001-create.json", convertible());
    const blocked = await hostFor(paths, blockingGates());
    const first = await blocked.runOnce();
    assert.equal(first.lastRun?.outcome, "escalated");
    assert.ok(first.reported.includes("escalated"));
    await blocked.close();

    // The Ticket is put back on its way: a newer file of the same Feature says so.
    publish(
      paths.source,
      "0002-update.json",
      convertible("F1", { kind: "update" }, [{ id: "42", resume: true }]),
    );
    const resumed = await hostFor(paths, passingGates());
    const second = await resumed.runOnce();
    assert.equal(second.lastRun?.outcome, "done");
    assert.ok(second.reported.includes("resumed"));
    assert.ok(second.reported.includes("done"));
    assert.equal(readFileSync(join(paths.workLineStable, "delivered.txt"), "utf8"), MARKER);

    // Every Event that states a fact is said under an id the manager can
    // recognise again: the round for what a `resume` repeats, the intention's
    // fingerprint for what an edit repeats.
    const ids = Object.fromEntries(
      threadRows(paths.emitterTarget, KEY).map((row) => [row.event, row.event_id]),
    );
    assert.match(String(ids.accepted), new RegExp(`^${KEY}:accepted:sha256:`));
    assert.equal(ids.escalated, `${KEY}:escalated:0:unit`);
    assert.equal(ids.resumed, `${KEY}:resumed:1`);
    assert.equal(ids.done, `${KEY}:done`);
  });

  it("4. cancel while a Ticket is escalated: Feature and Ticket cancelled, seed-only", async () => {
    const paths = sandbox();
    publish(paths.source, "0001-create.json", convertible());
    const blocked = await hostFor(paths, blockingGates());
    await blocked.runOnce();
    publish(paths.source, "0002-cancel.json", { id: "F1", kind: "cancel", project: "proj" });
    const tick = await blocked.runOnce();
    assert.deepEqual(tick.reported, ["cancelled", "cancelled"]);
    const feature = await blocked.ledger.getFeature(FEATURE);
    assert.equal(feature.ok && feature.aggregate.state, "cancelled");
    const ticket = await blocked.ledger.get(KEY);
    assert.equal(ticket.ok && ticket.aggregate.state, "cancelled");
    assert.equal(threadRows(paths.emitterTarget, FEATURE).at(-1)?.event_id, `${FEATURE}:cancelled`);
    assert.equal(existsSync(join(paths.workLineStable, "delivered.txt")), false);
  });

  it("5. second runOnce with saved Cursor does not re-deliver", async () => {
    const paths = sandbox();
    publish(paths.source, "0001-create.json", convertible());
    const host = await hostFor(paths, passingGates());
    await host.runOnce();
    const again = await host.runOnce();
    assert.deepEqual(again.reported, []);
    assert.equal(again.cursor, "0001-create.json");
  });

  it("6. Feature delivered again once done: skipped, not redriven", async () => {
    const paths = sandbox();
    publish(paths.source, "0001-create.json", convertible());
    const host = await hostFor(paths, passingGates());
    await host.runOnce();
    publish(paths.source, "0002-create.json", convertible());
    const tick = await host.runOnce();
    assert.deepEqual(tick.reported, []);
    assert.equal(tick.lastRun, undefined);
    assert.equal(tick.cursor, "0002-create.json");
    const skipped = journalEvents(paths.ledgerRoot).find((line) => line.event === "skipped");
    assert.deepEqual({ key: skipped?.key, state: skipped?.state }, { key: FEATURE, state: "done" });
  });

  it("7. invalid then corrected Feature: opened the second time", async () => {
    const paths = sandbox();
    publish(paths.source, "0001-create.json", { id: "F1", project: "proj" });
    const host = await hostFor(paths, passingGates());
    const first = await host.runOnce();
    assert.deepEqual(first.reported, ["invalid"]);
    publish(paths.source, "0002-create.json", convertible());
    const second = await host.runOnce();
    assert.deepEqual(second.reported, ["accepted", "accepted", "done", "progress", "done"]);
    assert.equal(readFileSync(join(paths.workLineStable, "delivered.txt"), "utf8"), MARKER);
  });

  it("7b. an invalid intention is told once until it changes", async () => {
    const paths = sandbox();
    const written = { id: "F1", project: "proj" };
    publish(paths.source, "0001-create.json", written);
    const host = await hostFor(paths, passingGates());
    const first = await host.runOnce();
    assert.deepEqual(first.reported, ["invalid"]);
    // The tracker echoing the report back: same content, delivered again.
    publish(paths.source, "0002-create.json", written);
    const second = await host.runOnce();
    assert.deepEqual(second.reported, []);
    assert.equal(second.cursor, "0002-create.json");
    // A human edited it, and it is still invalid for the same reason: told again.
    publish(paths.source, "0003-create.json", { ...written, priority: 1 });
    const third = await host.runOnce();
    assert.deepEqual(third.reported, ["invalid"]);
  });

  it("7c. no Event is emitted on the echo of its own report, in any state", async () => {
    // a Ticket escalated, the Feature held
    const escalated = sandbox();
    publish(escalated.source, "0001-create.json", convertible());
    const blocked = await hostFor(escalated, blockingGates());
    assert.ok((await blocked.runOnce()).reported.includes("escalated"));
    publish(escalated.source, "0002-create.json", convertible());
    assert.deepEqual((await blocked.runOnce()).reported, []);
    publish(escalated.source, "0003-create.json", convertible());
    assert.deepEqual((await blocked.runOnce()).reported, []);

    // cancelled
    publish(escalated.source, "0004-cancel.json", { id: "F1", kind: "cancel", project: "proj" });
    assert.deepEqual((await blocked.runOnce()).reported, ["cancelled", "cancelled"]);
    publish(escalated.source, "0005-cancel.json", { id: "F1", kind: "cancel", project: "proj" });
    assert.deepEqual((await blocked.runOnce()).reported, []);
    publish(escalated.source, "0006-create.json", convertible());
    assert.deepEqual((await blocked.runOnce()).reported, []);

    // done
    const done = sandbox();
    publish(done.source, "0001-create.json", convertible());
    const host = await hostFor(done, passingGates());
    assert.ok((await host.runOnce()).reported.includes("done"));
    for (const name of ["0002-create.json", "0003-create.json"]) {
      publish(done.source, name, convertible());
      assert.deepEqual((await host.runOnce()).reported, []);
    }
    // the issue closing after done is the tracker agreeing: nothing to say
    publish(done.source, "0004-cancel.json", { id: "F1", kind: "cancel", project: "proj" });
    assert.deepEqual((await host.runOnce()).reported, []);
    publish(done.source, "0005-cancel.json", { id: "F1", kind: "cancel", project: "proj" });
    assert.deepEqual((await host.runOnce()).reported, []);
  });

  it("8. resume and cancel for a Feature nobody admitted: Cursor advances, nothing else", async () => {
    const paths = sandbox();
    publish(paths.source, "0001-resume.json", { id: "F1", kind: "resume", project: "proj" });
    publish(paths.source, "0002-cancel.json", { id: "F1", kind: "cancel", project: "proj" });
    const host = await hostFor(paths, passingGates());
    const tick = await host.runOnce();
    assert.deepEqual(tick.reported, []);
    assert.equal(tick.lastRun, undefined);
    assert.equal(tick.cursor, "0002-cancel.json");
    assert.equal((await host.ledger.getFeature(FEATURE)).ok, false);
    assert.equal(hasThreads(paths.emitterTarget), false);
  });

  it("9. a Feature behind one whose Ticket escalated waits, and is told nothing", async () => {
    const paths = sandbox();
    publish(paths.source, "0001-create.json", convertible());
    const blocked = await hostFor(paths, blockingGates());
    assert.ok((await blocked.runOnce()).reported.includes("escalated"));

    publish(paths.source, "0002-create.json", convertible("F2", {}, [{ id: "43" }]));
    const queued = await blocked.runOnce();
    assert.deepEqual(queued.reported, []);
    const waiting = await blocked.ledger.getFeature("fake:F2");
    assert.equal(waiting.ok && waiting.aggregate.state, "waiting");
    assert.equal((await blocked.ledger.get("fake:43")).ok, false);
    assert.ok(threadEvents(paths.emitterTarget, KEY).includes("escalated"));

    publish(paths.source, "0003-create.json", convertible("F2", {}, [{ id: "43" }]));
    assert.deepEqual((await blocked.runOnce()).reported, []);
    const still = await blocked.ledger.getFeature("fake:F2");
    assert.equal(still.ok && still.aggregate.state, "waiting");
  });

  it("10. cancelling the Feature in front lets the sweep open the next in the same pass", async () => {
    const paths = sandbox();
    publish(paths.source, "0001-create.json", convertible());
    const blocked = await hostFor(paths, blockingGates());
    await blocked.runOnce();
    publish(paths.source, "0002-create.json", convertible("F2", {}, [{ id: "43" }]));
    await blocked.runOnce();

    publish(paths.source, "0003-cancel.json", { id: "F1", kind: "cancel", project: "proj" });
    const tick = await blocked.runOnce();
    assert.ok(tick.reported.includes("cancelled"));
    assert.ok(tick.reported.includes("escalated"));
    const next = await blocked.ledger.get("fake:43");
    assert.equal(next.ok && next.aggregate.state, "escalated");
    assert.equal(next.ok && next.aggregate.attempts_used, 1);
    assert.ok(threadEvents(paths.emitterTarget, "fake:43").includes("escalated"));
    assert.equal(threadEvents(paths.emitterTarget, KEY).includes("escalated"), true);
  });

  it("11. a restart with only a waiting Feature opens it, with no delivery", async () => {
    const paths = sandbox();
    publish(paths.source, "0001-create.json", convertible());
    const blocked = await hostFor(paths, blockingGates());
    await blocked.runOnce();
    publish(paths.source, "0002-create.json", convertible("F2", {}, [{ id: "43" }]));
    await blocked.runOnce();
    const cancelled = await blocked.cancel(FEATURE);
    assert.equal(cancelled.ok, true);
    await blocked.close();

    const again = await hostFor(paths, blockingGates());
    const tick = await again.runOnce();
    assert.deepEqual(tick.reported, ["accepted", "accepted", "escalated"]);
    const started = await again.ledger.get("fake:43");
    assert.equal(started.ok && started.aggregate.state, "escalated");
    const events = journalEvents(paths.ledgerRoot).map((entry) => entry.event);
    assert.equal(events.includes("sweep"), true);
    assert.equal(events.at(-1) === "idle", false);
    await again.close();
  });

  it("12. host.cancel abandons a Feature whose Ticket is escalated", async () => {
    const paths = sandbox();
    publish(paths.source, "0001-create.json", convertible());
    const host = await hostFor(paths, blockingGates());
    await host.runOnce();
    const result = await host.cancel(FEATURE);
    assert.equal(result.ok, true);
    const got = await host.ledger.getFeature(FEATURE);
    assert.equal(got.ok && got.aggregate.state, "cancelled");
    assert.ok(threadEvents(paths.emitterTarget, FEATURE).includes("cancelled"));
    assert.deepEqual(await host.cancel(FEATURE), { ok: false, code: "already-cancelled" });
    assert.deepEqual(await host.cancel("fake:nope"), { ok: false, code: "not-found" });
    await host.close();
  });

  it("13. host.cancel also abandons a Ticket by its own key", async () => {
    const paths = sandbox();
    publish(paths.source, "0001-create.json", convertible());
    const host = await hostFor(paths, blockingGates());
    await host.runOnce();
    assert.equal((await host.cancel(KEY)).ok, true);
    const got = await host.ledger.get(KEY);
    assert.equal(got.ok && got.aggregate.state, "cancelled");
    await host.close();
  });

  it("14. a Feature waits for the Feature it is blocked by", async () => {
    const paths = sandbox();
    publish(paths.source, "0001-create.json", convertible("F1", { priority: 10 }));
    publish(
      paths.source,
      "0002-create.json",
      convertible("F2", { priority: 99, blocked_by: ["F1"] }, [{ id: "43" }]),
    );
    const host = await hostFor(paths, passingGates());

    // F2 is the more urgent, and still waits for F1.
    const first = await host.runOnce();
    const one = await host.ledger.getFeature(FEATURE);
    assert.equal(one.ok && one.aggregate.state, "done");
    const two = await host.ledger.getFeature("fake:F2");
    assert.equal(two.ok && two.aggregate.state, "waiting");
    assert.equal(first.lastRun?.outcome, "done");

    const second = await host.runOnce();
    const opened = await host.ledger.getFeature("fake:F2");
    assert.equal(opened.ok && opened.aggregate.state, "done");
    assert.ok(second.reported.includes("accepted"));
  });

  it("15. a Feature opens only when all its Tickets are ready, and makes them in order", async () => {
    const paths = sandbox();
    publish(
      paths.source,
      "0001-create.json",
      convertible("F1", {}, [
        { id: "43", intention: "second", blocked_by: ["42"] },
        { id: "42", intention: "first" },
        { id: "44", intention: "not written yet", task_ready: false },
      ]),
    );
    const host = await hostFor(paths, passingGates());

    assert.deepEqual((await host.runOnce()).reported, []);
    const waiting = await host.ledger.getFeature(FEATURE);
    assert.equal(waiting.ok && waiting.aggregate.state, "waiting");
    assert.equal((await host.ledger.get(KEY)).ok, false);

    // The last Ticket is written and validated: the Feature opens, with no delivery.
    publish(
      paths.source,
      "0002-update.json",
      convertible("F1", { kind: "update" }, [
        { id: "43", intention: "second", blocked_by: ["42"] },
        { id: "42", intention: "first" },
        { id: "44", intention: "now written", blocked_by: ["43"] },
      ]),
    );
    const tick = await host.runOnce();
    assert.equal(tick.lastRun?.outcome, "done");
    const feature = await host.ledger.getFeature(FEATURE);
    assert.equal(feature.ok && feature.aggregate.state, "done");
    const landed = threadEvents(paths.emitterTarget, FEATURE).filter(
      (event) => event === "progress",
    );
    assert.equal(landed.length, 3);
    const order = journalEvents(paths.ledgerRoot)
      .filter((line) => line.event === "isolation-started")
      .map((line) => line.key);
    assert.deepEqual(order, ["fake:42", "fake:43", "fake:44"]);
  });
});
