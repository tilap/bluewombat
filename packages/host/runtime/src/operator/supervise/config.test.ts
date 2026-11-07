import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadSupervisorConfig } from "./config.js";

describe("supervisor defaults", () => {
  it("puts the prompt before --add-dir, which would otherwise swallow it", () => {
    const dir = mkdtempSync(join(tmpdir(), "supervise-config-"));
    const file = join(dir, "supervisor.yaml");
    writeFileSync(file, "pollIntervalMs: 1\n");
    const loaded = loadSupervisorConfig(file, dir);
    assert.ok(loaded.ok);
    for (const role of ["rootcause", "remedy", "skeptic", "arbiter", "fixer"]) {
      const cmd = loaded.ok ? (loaded.config.agents[role]?.cmd ?? []) : [];
      assert.ok(cmd.indexOf("{prompt}") < cmd.indexOf("{addDirArgs}"), role);
    }
  });
});
