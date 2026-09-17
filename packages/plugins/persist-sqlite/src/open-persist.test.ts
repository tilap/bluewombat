import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { FeatureAggregate } from "@bluewombat/work-ledger";
import { LEDGER_FILE, openPersist } from "./open-persist.js";

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

describe("openPersist", () => {
  it("is the SQLite Port, in one file under the ledger directory Host hands over", async () => {
    const ledgerRoot = join(mkdtempSync(join(tmpdir(), "ledger-sqlite-")), "ledger");
    const persist = await openPersist({ ledgerRoot });
    const saved = await persist.save("k:1", sample("k:1"));
    assert.deepEqual(saved, { ok: true });
    assert.ok(existsSync(join(ledgerRoot, LEDGER_FILE)));
    assert.deepEqual(
      readdirSync(ledgerRoot).filter((name) => !name.startsWith(LEDGER_FILE)),
      [],
      "nothing else of its own under the root",
    );
    assert.deepEqual(await persist.load("k:1"), sample("k:1"));
  });
});
