import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { openWorkLedger } from "@bluewombat/work-ledger";
import { openFilesystemPersist } from "./open-filesystem-persist.js";

describe("filesystem round-trip after admit", () => {
  it("writes <root>/<encoded-key>.json and load round-trips the aggregate", async () => {
    const root = mkdtempSync(join(tmpdir(), "work-ledger-roundtrip-"));
    const persist = await openFilesystemPersist({ root });
    const ledger = openWorkLedger({ persist, now: () => 1_000 });
    const admitted = await ledger.admit({
      key: "fake:42",
      project: "proj",
      fingerprint: "fp-1",
      priority: 1,
      intention: "do the thing",
    });
    assert.deepEqual(admitted, { ok: true });
    assert.equal(existsSync(join(root, "fake%3A42.json")), true);
    const loaded = await persist.load("fake:42");
    assert.equal(loaded?.state, "received");
    assert.equal(loaded?.intention.fingerprint, "fp-1");
    const got = await ledger.get("fake:42");
    assert.equal(got.ok && got.aggregate.state, "received");
  });
});
