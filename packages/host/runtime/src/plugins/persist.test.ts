import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { openPersist, resolvePersistModule } from "./persist.js";

function sandbox(): string {
  return mkdtempSync(join(tmpdir(), "persist-"));
}

describe("resolvePersistModule", () => {
  it("loads both shipped backends by name", async () => {
    for (const name of ["@bluewombat/persist-fs", "@bluewombat/persist-sqlite"]) {
      const resolved = await resolvePersistModule(name, process.cwd());
      assert.ok(resolved.ok, name);
      assert.equal(typeof resolved.module.openPersist, "function");
    }
  });

  it("refuses a module without openPersist", async () => {
    const root = sandbox();
    writeFileSync(join(root, "empty.mjs"), "export const nothing = 1;\n");
    const resolved = await resolvePersistModule("./empty.mjs", root);
    assert.ok(!resolved.ok);
    assert.match(
      resolved.reason,
      /^Persistence backend "\.\/empty\.mjs" does not export openPersist/,
    );
  });
});

describe("openPersist", () => {
  it("hands the backend the ledger directory and returns a working Port", async () => {
    const ledgerRoot = join(sandbox(), "ledger");
    const opened = await openPersist("@bluewombat/persist-sqlite", process.cwd(), ledgerRoot);
    assert.ok(opened.ok);
    assert.deepEqual(await opened.persist.listSummaries(), []);
    assert.ok(
      existsSync(join(ledgerRoot, "ledger.sqlite")),
      "the backend chose where under the root",
    );
  });

  it("relays a backend that cannot be loaded", async () => {
    const opened = await openPersist("@acme/persist-nowhere", sandbox(), "/nowhere");
    assert.ok(!opened.ok);
    assert.match(opened.reason, /npm install @acme\/persist-nowhere/);
  });
});
