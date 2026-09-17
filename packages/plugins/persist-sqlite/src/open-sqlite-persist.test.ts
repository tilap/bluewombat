import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { FeatureAggregate } from "@bluewombat/work-ledger";
import { openWorkLedger } from "@bluewombat/work-ledger";
import { openSqlitePersist } from "./open-sqlite-persist.js";

function tempDb(): string {
  return join(mkdtempSync(join(tmpdir(), "persist-sqlite-")), "ledger.sqlite");
}

function sample(key: string): FeatureAggregate {
  return {
    intention: {
      key,
      project: "proj",
      fingerprint: "fp-1",
      priority: 1,
      intention: "do the thing",
    },
    state: "received",
    received_at: 1_000,
    attempts: [],
    attempts_used: 0,
  };
}

describe("openSqlitePersist", () => {
  it("creates the parent directory when it is missing", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "persist-sqlite-")), "nested", "ledger.sqlite");
    const persist = await openSqlitePersist({ path });
    const saved = await persist.save("fake:42", sample("fake:42"));
    assert.deepEqual(saved, { ok: true });
    const loaded = await persist.load("fake:42");
    assert.equal(loaded?.intention.key, "fake:42");
  });

  it("throws when path is not absolute", async () => {
    await assert.rejects(
      () => openSqlitePersist({ path: "relative/ledger.sqlite" }),
      /absolute file path/,
    );
  });

  it("load returns undefined for an unknown key", async () => {
    const persist = await openSqlitePersist({ path: tempDb() });
    assert.equal(await persist.load("missing:1"), undefined);
  });

  it("save replaces the whole aggregate and load round-trips it", async () => {
    const persist = await openSqlitePersist({ path: tempDb() });
    await persist.save("fake:42", sample("fake:42"));
    const next = sample("fake:42");
    next.state = "planning";
    next.bail = { expires_at: 9_000 };
    await persist.save("fake:42", next);
    const loaded = await persist.load("fake:42");
    assert.equal(loaded?.state, "planning");
    assert.equal(loaded?.bail?.expires_at, 9_000);
  });

  it("listSummaries returns one summary per stored key", async () => {
    const persist = await openSqlitePersist({ path: tempDb() });
    await persist.save("fake:1", sample("fake:1"));
    const second = sample("fake:2");
    second.intention.priority = 9;
    await persist.save("fake:2", second);
    const summaries = await persist.listSummaries();
    const keys = summaries.map((row) => row.key).sort();
    assert.deepEqual(keys, ["fake:1", "fake:2"]);
    assert.equal(summaries.find((row) => row.key === "fake:2")?.priority, 9);
  });
});

describe("sqlite round-trip after admit", () => {
  it("persists an admitted FeatureStandard and load round-trips it", async () => {
    const persist = await openSqlitePersist({ path: tempDb() });
    const ledger = openWorkLedger({ persist, now: () => 1_000 });
    const admitted = await ledger.admit({
      key: "fake:42",
      project: "proj",
      fingerprint: "fp-1",
      priority: 1,
      intention: "do the thing",
    });
    assert.deepEqual(admitted, { ok: true });
    const loaded = await persist.load("fake:42");
    assert.equal(loaded?.state, "received");
    assert.equal(loaded?.intention.fingerprint, "fp-1");
    const got = await ledger.get("fake:42");
    assert.equal(got.ok && got.aggregate.state, "received");
  });
});
