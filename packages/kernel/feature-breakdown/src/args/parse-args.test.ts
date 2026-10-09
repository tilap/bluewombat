import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseArgs } from "./parse-args.js";

function workspaceDir(): string {
  return mkdtempSync(join(tmpdir(), "feature-breakdown-args-"));
}

function required(workspace: string = workspaceDir()): string[] {
  return [
    "--max-feature-bytes",
    "1000",
    "--max-units",
    "10",
    "--planner",
    "--",
    "node",
    "planner.js",
    "--planner-duration-ms",
    "5000",
    "--workspace",
    workspace,
  ];
}

describe("parseArgs", () => {
  it("parses a minimal valid invocation with --feature", () => {
    const result = parseArgs(["--feature", '{"key":"k"}', ...required()]);
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.invocation.featureJson, '{"key":"k"}');
    assert.equal(result.invocation.maxFeatureBytes, 1000);
    assert.equal(result.invocation.maxUnits, 10);
    assert.deepEqual(result.invocation.plannerArgv, ["node", "planner.js"]);
    assert.equal(result.invocation.plannerDurationMs, 5000);
    assert.deepEqual(result.invocation.gates, []);
  });

  it("allows omitting --feature (stdin later)", () => {
    const result = parseArgs(required());
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.invocation.featureJson, undefined);
  });

  it("parses --on-status and --at", () => {
    const result = parseArgs([
      ...required(),
      "--on-status",
      "--",
      "node",
      "hook.js",
      "--at",
      "2026-09-05T10:00:00.000Z",
    ]);
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.deepEqual(result.invocation.onStatusArgv, ["node", "hook.js"]);
    assert.equal(result.invocation.plannedAt, "2026-09-05T10:00:00.000Z");
  });

  it("rejects missing --planner", () => {
    const result = parseArgs([
      "--max-feature-bytes",
      "1",
      "--max-units",
      "1",
      "--planner-duration-ms",
      "1",
      "--workspace",
      workspaceDir(),
    ]);
    assert.equal(result.ok, false);
  });

  it("rejects missing --planner-duration-ms", () => {
    const result = parseArgs([
      "--max-feature-bytes",
      "1",
      "--max-units",
      "1",
      "--planner",
      "--",
      "echo",
      "--workspace",
      workspaceDir(),
    ]);
    assert.equal(result.ok, false);
  });

  it("rejects an empty Planner command", () => {
    const result = parseArgs([
      "--max-feature-bytes",
      "1",
      "--max-units",
      "1",
      "--planner",
      "--",
      "--planner-duration-ms",
      "1",
      "--workspace",
      workspaceDir(),
    ]);
    assert.equal(result.ok, false);
  });

  it("rejects a non-positive bound", () => {
    const result = parseArgs([
      "--max-feature-bytes",
      "0",
      "--max-units",
      "1",
      "--planner",
      "--",
      "echo",
      "--planner-duration-ms",
      "1",
      "--workspace",
      workspaceDir(),
    ]);
    assert.equal(result.ok, false);
  });

  it("rejects an unknown argument", () => {
    const result = parseArgs([...required(), "--bogus"]);
    assert.equal(result.ok, false);
  });

  it("rejects a malformed --at", () => {
    const result = parseArgs([...required(), "--at", "not-a-date"]);
    assert.equal(result.ok, false);
  });

  it("rejects a missing --workspace", () => {
    const result = parseArgs([
      "--max-feature-bytes",
      "1",
      "--max-units",
      "1",
      "--planner",
      "--",
      "echo",
      "--planner-duration-ms",
      "1",
    ]);
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.reason, /Missing required --workspace/);
  });

  it("rejects a workspace that does not exist", () => {
    const result = parseArgs(required("/tmp/feature-breakdown-does-not-exist-xyz"));
    assert.equal(result.ok, false);
  });

  it("parses ordered Gates", () => {
    const result = parseArgs([
      ...required(),
      "--gate-timeout-ms",
      "100",
      "--gate",
      "lint",
      "--",
      "node",
      "lint.js",
      "--gate-timeout-ms",
      "100",
      "--gate",
      "test",
      "--",
      "node",
      "test.js",
    ]);
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.deepEqual(
      result.invocation.gates.map((g) => g.id),
      ["lint", "test"],
    );
  });

  it("rejects duplicate Gate ids", () => {
    const result = parseArgs([
      ...required(),
      "--gate-timeout-ms",
      "1",
      "--gate",
      "lint",
      "--",
      "echo",
      "--gate-timeout-ms",
      "1",
      "--gate",
      "lint",
      "--",
      "echo",
    ]);
    assert.equal(result.ok, false);
  });

  it("refuses a Gate that carries no ceiling, because nothing else would bound it", () => {
    const result = parseArgs([...required(), "--gate", "lint", "--", "echo", "ok"]);
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.reason, /Gate "lint" has no --gate-timeout-ms/);
  });
});
