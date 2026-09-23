import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import {
  emitFailure,
  emitPlan,
  emitRefusal,
  emitVerdict,
  writeContract,
  writeDiagnostic,
} from "./emit.js";

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

describe("emitPlan", () => {
  it("wraps the subtasks under one key", () => {
    const out = collector();
    const subtasks = [{ id: "A", intention: "i", definition_of_done: "d", depends_on: [] }];
    emitPlan(subtasks, out.write);
    assert.deepEqual(only(out.lines), { subtasks });
  });
});

describe("emitRefusal", () => {
  it("names the refusal code FeatureBreakdown reads", () => {
    const out = collector();
    emitRefusal("It asks for two contradictory results.", out.write);
    assert.deepEqual(only(out.lines), {
      outcome: "refused",
      code: "not-specifiable",
      reason: "It asks for two contradictory results.",
    });
  });
});

describe("writeContract", () => {
  it("delivers a large line through an immediate process.exit", () => {
    // process.stdout.write + process.exit can drop the userspace buffer on some
    // hosts (seen locally with 16KiB+). writeSync(1) is the contract path that
    // survives exit everywhere; assert that, not the race.
    const body = "x".repeat(200_000);
    const line = JSON.stringify({ body });
    const kept = spawnSync(
      process.execPath,
      [
        "-e",
        `import { writeSync } from "node:fs"; writeSync(1, ${JSON.stringify(`${line}\n`)}); process.exit(0);`,
      ],
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
    );
    assert.equal(kept.status, 0);
    assert.equal(kept.stdout.length, line.length + 1);
    assert.deepEqual(JSON.parse(kept.stdout.trim()), { body });
  });

  it("is the function slots call", () => {
    assert.equal(typeof writeContract, "function");
    assert.equal(typeof writeDiagnostic, "function");
  });
});
