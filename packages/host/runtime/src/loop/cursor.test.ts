import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { cursorPath, loadCursor, saveCursor } from "./cursor.js";

describe("the Cursor file", () => {
  it("is nothing until saved, then reads back what was saved", async () => {
    const ledgerRoot = join(mkdtempSync(join(tmpdir(), "cursor-")), "ledger");
    assert.equal(await loadCursor(ledgerRoot), undefined);
    await saveCursor(ledgerRoot, "0002-ready.json");
    assert.equal(await loadCursor(ledgerRoot), "0002-ready.json");
  });

  it("reads a blank file as no Cursor at all", async () => {
    const ledgerRoot = mkdtempSync(join(tmpdir(), "cursor-"));
    writeFileSync(cursorPath(ledgerRoot), " \n");
    assert.equal(await loadCursor(ledgerRoot), undefined);
  });
});
