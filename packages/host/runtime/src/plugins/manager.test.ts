import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { resolveManagerModule } from "./manager.js";

describe("resolveManagerModule", () => {
  it("loads an installed manager package by name", async () => {
    const resolved = await resolveManagerModule("@bluewombat/manager-fake", process.cwd());
    assert.equal(resolved.ok, true);
    if (resolved.ok) {
      assert.equal(typeof resolved.module.createManager, "function");
    }
  });

  it("loads a manager from a path next to the config file", async () => {
    const root = mkdtempSync(join(tmpdir(), "manager-path-"));
    writeFileSync(
      join(root, "local-manager.mjs"),
      "export function createManager() { return { ok: false, reason: 'stub' }; }\n",
    );
    const resolved = await resolveManagerModule("./local-manager.mjs", root);
    assert.equal(resolved.ok, true);
  });

  it("refuses a module without createManager, and says how to install a missing one", async () => {
    const root = mkdtempSync(join(tmpdir(), "manager-path-"));
    writeFileSync(join(root, "empty.mjs"), "export const nothing = 1;\n");
    const wrongShape = await resolveManagerModule("./empty.mjs", root);
    assert.equal(wrongShape.ok, false);
    assert.match(wrongShape.ok === false ? wrongShape.reason : "", /does not export createManager/);

    const missing = await resolveManagerModule("@acme/manager-nowhere", root);
    assert.equal(missing.ok, false);
    assert.match(missing.ok === false ? missing.reason : "", /npm install @acme\/manager-nowhere/);
  });
});
