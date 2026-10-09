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
const MARKER = "subtask done\n";
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

function convertible(id = "42"): Record<string, unknown> {
  return {
    id,
    project: "proj",
    intention: "deliver the marker file",
    priority: 75,
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

function planner(): string[] {
  return [node, join(fixtures, "planner-one-subtask.mjs")];
}

function builder(): string[] {
  return [node, join(fixtures, "builder-write-marker.mjs")];
}

function threadEvents(target: string, key?: string): unknown[] {
  const files = readdirSync(target).filter((name) => name.endsWith(".ndjson"));
  if (key === undefined) {
    assert.equal(files.length, 1);
  }
  for (const name of files) {
    const body = readFileSync(join(target, name), "utf8").trim();
    if (body.length === 0) {
      continue;
    }
    const rows = body
      .split("\n")
      .map((line) => JSON.parse(line) as { event: string; key?: string });
    if (key === undefined || rows.some((row) => row.key === key)) {
      return rows.map((row) => row.event);
    }
  }
  assert.fail(key === undefined ? "no Thread was opened" : `no Thread for ${key}`);
}

/** The Thread's rows as written: the Event and the id it was said under. */
function threadRows(target: string): { event: string; event_id?: string }[] {
  const files = readdirSync(target).filter((name) => name.endsWith(".ndjson"));
  assert.equal(files.length, 1);
  const file = files[0];
  assert.ok(file !== undefined);
  return readFileSync(join(target, file), "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { event: string; event_id?: string });
}

function journalEvents(ledgerRoot: string): Record<string, unknown>[] {
  return readFileSync(join(ledgerRoot, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The Thread's Events, or nothing when no Thread was ever opened. */
function threadEventsOrNone(target: string): unknown[] | undefined {
  return readdirSync(target).some((name) => name.endsWith(".ndjson"))
    ? threadEvents(target)
    : undefined;
}

async function hostFor(paths: Paths, gates: GateSpec[], over: Partial<HostOptions> = {}) {
  return await openHost({
    ...over,
    manager: "@bluewombat/manager-fake",
    managerOptions: { source: paths.source, target: paths.emitterTarget },
    workLineStable: paths.workLineStable,
    workLineIsolation: "@bluewombat/isolation-copy",
    workspaceRoot: paths.workspaceRoot,
    ledgerRoot: paths.ledgerRoot,
    planner: { cmd: planner(), timeoutMs: 30_000, gates: [] },
    builder: {
      producer: { cmd: builder(), timeoutMs: 30_000, gates },
      repair: { cmd: builder(), timeoutMs: 30_000, gates: [] },
    },
    assembly: { gates: [] },
    timeoutMs: 30_000,
  });
}

describe("host", () => {
  it("0. one whole pass: every line names its run and its feature, and the children are filmed", async () => {
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

    // Every line about a Task says which feature it served. Before this, the
    // Implementer's lines carried a bare `s1` and the Isolator a bare id.
    const orphans = lines.filter(
      (line) =>
        (line.task_id !== undefined || line.id !== undefined) &&
        line.key === undefined &&
        line.event !== "host-started",
    );
    assert.deepEqual(orphans, [], "a line about a Task that cannot be joined to its feature");
    for (const event of ["status", "attempt-started", "gate-finished", "isolation-started"]) {
      const found = lines.find((line) => line.event === event);
      assert.equal(found?.key, KEY, `${event} names the feature`);
    }

    // The children were filmed, and the journal names the files.
    const opened = lines.filter((line) => line.event === "stream-opened");
    assert.ok(opened.length >= 2, "the Planner and the Builder were both filmed");
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

    // The feature landed, so nobody has to read them: the bytes are gone and
    // the film says how much there was.
    const dropped = lines.find((line) => line.event === "streams-discarded");
    assert.equal(dropped?.key, KEY);
    assert.ok(Number(dropped?.files) > 0 && Number(dropped?.bytes) > 0);
    assert.equal(existsSync(join(streamsDir, "fake-42")), false);
  });

  it("1. convertible upsert: marker on WorkLineStable, accepted planned done, Cursor saved", async () => {
    const paths = sandbox();
    publish(paths.source, "0001-create.json", convertible());
    const host = await hostFor(paths, passingGates());
    const tick = await host.runOnce();
    assert.equal(tick.lastRun?.outcome, "done");
    assert.deepEqual(tick.reported, ["accepted", "planned", "progress", "done"]);
    assert.equal(tick.cursor, "0001-create.json");
    assert.equal(readFileSync(join(paths.workLineStable, "delivered.txt"), "utf8"), MARKER);
    assert.equal(readFileSync(cursorPath(paths.ledgerRoot), "utf8").trim(), "0001-create.json");
    assert.deepEqual(threadEvents(paths.emitterTarget), [
      "accepted",
      "planned",
      "progress",
      "done",
    ]);
    const events = journalEvents(paths.ledgerRoot).map((line) => line.event);
    assert.equal(events.includes("listen"), true);
    assert.equal(events.includes("admitted"), true);
    assert.equal(events.includes("status"), true);
    assert.equal(events.includes("gate-finished"), true);
    assert.equal(events.includes("reported"), true);
  });

  it("1b. the ledger lands where the persist backend a config names puts it", async () => {
    const paths = sandbox();
    publish(paths.source, "0001-create.json", convertible());
    const host = await hostFor(paths, passingGates(), { persist: "@bluewombat/persist-sqlite" });
    const tick = await host.runOnce();
    assert.equal(tick.lastRun?.outcome, "done");
    // The Feature is in SQLite, and nowhere else under the ledger root.
    assert.ok(existsSync(join(paths.ledgerRoot, "ledger.sqlite")));
    assert.equal(
      readdirSync(paths.ledgerRoot).some((name) => name.endsWith(".json")),
      false,
    );
    const listed = await host.ledger.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.state, "done");
    // Host's own files still sit beside it: the backend owns the bytes, not the root.
    assert.equal(readFileSync(cursorPath(paths.ledgerRoot), "utf8").trim(), "0001-create.json");
    assert.ok(existsSync(join(paths.ledgerRoot, "events.jsonl")));
  });

  it("2. invalid upsert: invalid Thread, Cursor advanced, seed-only", async () => {
    const paths = sandbox();
    publish(paths.source, "0001-create.json", {
      id: "42",
      project: "proj",
    });
    const host = await hostFor(paths, passingGates());
    const tick = await host.runOnce();
    assert.equal(tick.lastRun, undefined);
    assert.deepEqual(tick.reported, ["invalid"]);
    const got = await host.ledger.get(KEY);
    assert.equal(got.ok && got.aggregate.state, "invalid");
    assert.equal(existsSync(join(paths.workLineStable, "delivered.txt")), false);
    assert.equal(tick.cursor, "0001-create.json");
  });

  it("3. fail-blocking then ready with passing Gates: escalated, resumed, done", async () => {
    const paths = sandbox();
    publish(paths.source, "0001-create.json", convertible());
    const blocked = await hostFor(paths, blockingGates());
    const first = await blocked.runOnce();
    assert.equal(first.lastRun?.outcome, "escalated");
    assert.ok(first.reported.includes("escalated"));

    publish(paths.source, "0002-ready.json", { id: "42", kind: "ready", project: "proj" });
    const resumed = await hostFor(paths, passingGates());
    const second = await resumed.runOnce();
    assert.equal(second.lastRun?.outcome, "done");
    assert.ok(second.reported.includes("resumed"));
    assert.ok(second.reported.includes("done"));
    assert.equal(readFileSync(join(paths.workLineStable, "delivered.txt"), "utf8"), MARKER);
    assert.equal(second.cursor, "0002-ready.json");

    // Every Event that states a fact is said under an id the manager can
    // recognise again: the round for what a `ready` repeats, the intention's
    // fingerprint for what an edit repeats.
    const ids = Object.fromEntries(
      threadRows(paths.emitterTarget).map((row) => [row.event, row.event_id]),
    );
    assert.match(String(ids.accepted), new RegExp(`^${KEY}:accepted:sha256:`));
    assert.equal(ids.escalated, `${KEY}:escalated:0:subtask:A`);
    assert.equal(ids.resumed, `${KEY}:resumed:1`);
    assert.equal(ids.done, `${KEY}:done`);
  });

  it("4. cancel while escalated: cancelled, seed-only", async () => {
    const paths = sandbox();
    publish(paths.source, "0001-create.json", convertible());
    const blocked = await hostFor(paths, blockingGates());
    await blocked.runOnce();
    publish(paths.source, "0002-cancel.json", { id: "42", kind: "cancel", project: "proj" });
    const tick = await blocked.runOnce();
    assert.deepEqual(tick.reported, ["cancelled"]);
    const got = await blocked.ledger.get(KEY);
    assert.equal(got.ok && got.aggregate.state, "cancelled");
    assert.equal(threadRows(paths.emitterTarget).at(-1)?.event_id, `${KEY}:cancelled`);
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

  it("6. upsert delivered again for a done feature: skipped, not redriven", async () => {
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
    assert.deepEqual({ key: skipped?.key, state: skipped?.state }, { key: KEY, state: "done" });
  });

  it("7. invalid then corrected upsert: admitted the second time", async () => {
    const paths = sandbox();
    publish(paths.source, "0001-create.json", { id: "42", project: "proj" });
    const host = await hostFor(paths, passingGates());
    const first = await host.runOnce();
    assert.deepEqual(first.reported, ["invalid"]);
    publish(paths.source, "0002-create.json", convertible());
    const second = await host.runOnce();
    assert.deepEqual(second.reported, ["accepted", "planned", "progress", "done"]);
    assert.equal(readFileSync(join(paths.workLineStable, "delivered.txt"), "utf8"), MARKER);
  });

  it("7b. an invalid intention is told once until it changes", async () => {
    const paths = sandbox();
    const written = { id: "42", project: "proj" };
    publish(paths.source, "0001-create.json", written);
    const host = await hostFor(paths, passingGates());
    const first = await host.runOnce();
    assert.deepEqual(first.reported, ["invalid"]);
    // The tracker echoing the report back: same content, delivered again.
    publish(paths.source, "0002-create.json", written);
    const second = await host.runOnce();
    assert.deepEqual(second.reported, []);
    assert.equal(second.cursor, "0002-create.json");
    const skipped = journalEvents(paths.ledgerRoot).find((line) => line.event === "skipped");
    assert.deepEqual({ key: skipped?.key, state: skipped?.state }, { key: KEY, state: "invalid" });
    // A human edited it, and it is still invalid for the same reason: told again.
    publish(paths.source, "0003-create.json", { ...written, priority: 1 });
    const third = await host.runOnce();
    assert.deepEqual(third.reported, ["invalid"]);
  });

  it("7c. no Event is emitted on the echo of its own report, in any state", async () => {
    // escalated
    const escalated = sandbox();
    publish(escalated.source, "0001-create.json", convertible());
    const blocked = await hostFor(escalated, blockingGates());
    assert.ok((await blocked.runOnce()).reported.includes("escalated"));
    publish(escalated.source, "0002-create.json", convertible());
    assert.deepEqual((await blocked.runOnce()).reported, []);
    publish(escalated.source, "0003-create.json", convertible());
    assert.deepEqual((await blocked.runOnce()).reported, []);

    // cancelled
    publish(escalated.source, "0004-cancel.json", { id: "42", kind: "cancel", project: "proj" });
    assert.deepEqual((await blocked.runOnce()).reported, ["cancelled"]);
    publish(escalated.source, "0005-cancel.json", { id: "42", kind: "cancel", project: "proj" });
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
    publish(done.source, "0004-cancel.json", { id: "42", kind: "cancel", project: "proj" });
    assert.deepEqual((await host.runOnce()).reported, []);
    publish(done.source, "0005-cancel.json", { id: "42", kind: "cancel", project: "proj" });
    assert.deepEqual((await host.runOnce()).reported, []);
  });

  it("8. ready and cancel for a feature nobody admitted: Cursor advances, nothing else", async () => {
    const paths = sandbox();
    publish(paths.source, "0001-ready.json", { id: "42", kind: "ready", project: "proj" });
    publish(paths.source, "0002-cancel.json", { id: "42", kind: "cancel", project: "proj" });
    const host = await hostFor(paths, passingGates());
    const tick = await host.runOnce();
    assert.deepEqual(tick.reported, []);
    assert.equal(tick.lastRun, undefined);
    assert.equal(tick.cursor, "0002-cancel.json");
    const got = await host.ledger.get(KEY);
    assert.equal(got.ok, false);
    assert.equal(threadEventsOrNone(paths.emitterTarget), undefined);
  });

  it("9. a Feature behind an escalation is queued, not told it escalated", async () => {
    const paths = sandbox();
    publish(paths.source, "0001-create.json", convertible());
    const blocked = await hostFor(paths, blockingGates());
    assert.ok((await blocked.runOnce()).reported.includes("escalated"));

    publish(paths.source, "0002-create.json", convertible("43"));
    const queued = await blocked.runOnce();
    assert.deepEqual(queued.reported, ["accepted", "progress"]);
    const waiting = await blocked.ledger.get("fake:43");
    assert.equal(waiting.ok && waiting.aggregate.state, "received");
    const line = journalEvents(paths.ledgerRoot).find((entry) => entry.event === "queued");
    assert.deepEqual({ key: line?.key, behind: line?.behind }, { key: "fake:43", behind: KEY });
    assert.deepEqual(threadEvents(paths.emitterTarget, "fake:43"), ["accepted", "progress"]);
    assert.ok(threadEvents(paths.emitterTarget, KEY).includes("escalated"));

    publish(paths.source, "0003-create.json", convertible("43"));
    assert.deepEqual((await blocked.runOnce()).reported, []);
    publish(paths.source, "0004-create.json", convertible("43"));
    assert.deepEqual((await blocked.runOnce()).reported, []);
    const still = await blocked.ledger.get("fake:43");
    assert.equal(still.ok && still.aggregate.state, "received");
  });

  it("10. cancelling the blocker lets the sweep start the queue in the same pass", async () => {
    const paths = sandbox();
    publish(paths.source, "0001-create.json", convertible());
    const blocked = await hostFor(paths, blockingGates());
    await blocked.runOnce();
    publish(paths.source, "0002-create.json", convertible("43"));
    await blocked.runOnce();

    publish(paths.source, "0003-cancel.json", { id: "42", kind: "cancel", project: "proj" });
    const tick = await blocked.runOnce();
    assert.ok(tick.reported.includes("cancelled"));
    assert.ok(tick.reported.includes("escalated"));
    const next = await blocked.ledger.get("fake:43");
    assert.equal(next.ok && next.aggregate.state, "escalated");
    assert.equal(next.ok && next.aggregate.attempts_used, 1);
    assert.ok(threadEvents(paths.emitterTarget, "fake:43").includes("escalated"));
    assert.equal(threadEvents(paths.emitterTarget, KEY).includes("escalated"), true);
  });

  it("11. a restart with only a received Feature starts it, with no delivery", async () => {
    const paths = sandbox();
    publish(paths.source, "0001-create.json", convertible());
    const blocked = await hostFor(paths, blockingGates());
    await blocked.runOnce();
    publish(paths.source, "0002-create.json", convertible("43"));
    await blocked.runOnce();
    const cancelled = await blocked.conductor.cancel(KEY);
    assert.equal(cancelled.ok, true);
    await blocked.close();

    const again = await hostFor(paths, blockingGates());
    const tick = await again.runOnce();
    assert.deepEqual(tick.reported, ["planned", "escalated"]);
    const started = await again.ledger.get("fake:43");
    assert.equal(started.ok && started.aggregate.state, "escalated");
    const events = journalEvents(paths.ledgerRoot).map((entry) => entry.event);
    assert.equal(events.includes("sweep"), true);
    assert.equal(events.at(-1) === "idle", false);
    await again.close();
  });

  it("12. host.cancel abandons an escalated Feature", async () => {
    const paths = sandbox();
    publish(paths.source, "0001-create.json", convertible());
    const host = await hostFor(paths, blockingGates());
    await host.runOnce();
    const result = await host.cancel(KEY);
    assert.equal(result.ok, true);
    const got = await host.ledger.get(KEY);
    assert.equal(got.ok && got.aggregate.state, "cancelled");
    assert.ok(threadEvents(paths.emitterTarget).includes("cancelled"));
    await host.close();
  });
});
