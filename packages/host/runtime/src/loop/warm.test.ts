import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { openWarm } from "./warm.js";

const node = process.execPath;

describe("openWarm", () => {
  it("runs the Project command in the Feature workspace and reports warmed", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "warm-ok-"));
    const lines: Record<string, unknown>[] = [];
    const warm = openWarm({
      pass: {
        cmd: [node, "-e", "process.exit(0)"],
        timeoutMs: 5_000,
      },
      journal: { append: (line) => lines.push(line) },
    });
    assert.equal(warm.durationMs, 5_000);
    assert.deepEqual(await warm.prepare({ workspace, durationMs: 5_000 }), {
      outcome: "warmed",
    });
    assert.ok(lines.some((line) => line.event === "warm" && line.outcome === "warmed"));
  });

  it("reports failed when the command exits non-zero", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "warm-fail-"));
    const warm = openWarm({
      pass: {
        cmd: [node, "-e", "process.exit(2)"],
        timeoutMs: 5_000,
      },
    });
    assert.deepEqual(await warm.prepare({ workspace, durationMs: 5_000 }), {
      outcome: "failed",
    });
  });

  it("reports interrupted when the Host flag is already set", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "warm-int-"));
    const warm = openWarm({
      pass: { cmd: [node, "-e", "process.exit(0)"], timeoutMs: 5_000 },
      interruptFlag: { interrupted: true },
    });
    assert.deepEqual(await warm.prepare({ workspace, durationMs: 5_000 }), {
      outcome: "interrupted",
    });
  });
});
