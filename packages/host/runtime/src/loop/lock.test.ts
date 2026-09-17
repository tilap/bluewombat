import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { acquireLock, lockPath } from "./lock.js";

describe("acquireLock", () => {
  it("names this process, and lets it go on release", async () => {
    const ledger = mkdtempSync(join(tmpdir(), "lock-"));
    const release = await acquireLock(ledger);
    assert.equal(readFileSync(lockPath(ledger), "utf8").trim(), String(process.pid));
    await release();
    assert.throws(() => readFileSync(lockPath(ledger)));
  });

  it("refuses while another live process holds the ledger", async () => {
    const ledger = mkdtempSync(join(tmpdir(), "lock-"));
    // The parent of the test runner is alive and is not us.
    writeFileSync(lockPath(ledger), `${process.ppid}\n`);
    await assert.rejects(acquireLock(ledger), /Another mason run \(pid \d+\) holds/);
  });

  it("takes over a lock a dead process left behind, and its own", async () => {
    const ledger = mkdtempSync(join(tmpdir(), "lock-"));
    writeFileSync(lockPath(ledger), "999999999\n");
    const release = await acquireLock(ledger);
    assert.equal(readFileSync(lockPath(ledger), "utf8").trim(), String(process.pid));
    const again = await acquireLock(ledger);
    assert.equal(readFileSync(lockPath(ledger), "utf8").trim(), String(process.pid));
    await again();
    await release();
  });
});
