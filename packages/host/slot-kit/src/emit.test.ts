import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { emitFailure, emitVerdict, writeContract, writeDiagnostic } from "./emit.js";

/** Collects what a slot would have put on stdout. */
function collector(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
}

function only(lines: string[]): Record<string, unknown> {
  assert.equal(lines.length, 1);
  const line = lines[0];
  assert.ok(line !== undefined);
  assert.ok(line.endsWith("\n"), "the line must be terminated");
  assert.ok(!line.slice(0, -1).includes("\n"), "one line, whatever the report says");
  return JSON.parse(line) as Record<string, unknown>;
}

describe("emitVerdict", () => {
  it("writes one terminated JSON line", () => {
    const out = collector();
    emitVerdict("pass", "", out.write);
    assert.deepEqual(only(out.lines), { verdict: "pass", report: "" });
  });

  it("defaults the report to empty", () => {
    const out = collector();
    emitVerdict("fail-blocking", undefined, out.write);
    assert.deepEqual(only(out.lines), { verdict: "fail-blocking", report: "" });
  });

  it("keeps a multi-line report on one line", () => {
    const out = collector();
    emitVerdict("fail-retryable", "first\nsecond", out.write);
    assert.equal(only(out.lines).report, "first\nsecond");
  });
});

describe("emitFailure", () => {
  it("answers with an outcome, not a verdict", () => {
    const out = collector();
    emitFailure("fail-retryable", "the agent gave up", out.write);
    assert.deepEqual(only(out.lines), { outcome: "fail-retryable", report: "the agent gave up" });
  });
});
