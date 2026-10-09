import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseArgs } from "./parse-args.js";

function workspaceDir(): string {
  return mkdtempSync(join(tmpdir(), "implementer-args-"));
}

function args(over: string[]): string[] {
  return [
    "--id",
    "t",
    "--intention",
    "i",
    "--definition-of-done",
    "d",
    "--workspace",
    workspaceDir(),
    "--max-attempts",
    "1",
    ...over,
  ];
}

describe("parseArgs", () => {
  it("parses a minimal valid invocation with no Gates", () => {
    const workspace = workspaceDir();
    const result = parseArgs([
      "--id",
      "task-1",
      "--intention",
      "do it",
      "--definition-of-done",
      "done",
      "--workspace",
      workspace,
      "--builder",
      "--",
      "echo",
      "ok",
      "--max-attempts",
      "3",
      "--builder-timeout-ms",
      "1000",
    ]);
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.invocation.id, "task-1");
    assert.deepEqual(result.invocation.builderArgv, ["echo", "ok"]);
    assert.deepEqual(result.invocation.gates, []);
    assert.equal(result.invocation.maxAttempts, 3);
  });

  it("parses ordered Gates and on-status", () => {
    const workspace = workspaceDir();
    const result = parseArgs([
      "--id",
      "t",
      "--intention",
      "i",
      "--definition-of-done",
      "d",
      "--workspace",
      workspace,
      "--builder",
      "--",
      "node",
      "builder.js",
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
      "--max-attempts",
      "2",
      "--builder-timeout-ms",
      "100",
      "--on-status",
      "--",
      "node",
      "hook.js",
    ]);
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.deepEqual(
      result.invocation.gates.map((g) => g.id),
      ["lint", "test"],
    );
    assert.deepEqual(result.invocation.onStatusArgv, ["node", "hook.js"]);
  });

  it("rejects duplicate Gate ids", () => {
    const workspace = workspaceDir();
    const result = parseArgs([
      "--id",
      "t",
      "--intention",
      "i",
      "--definition-of-done",
      "d",
      "--workspace",
      workspace,
      "--builder",
      "--",
      "echo",
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
      "--max-attempts",
      "1",
      "--builder-timeout-ms",
      "1",
    ]);
    assert.equal(result.ok, false);
  });

  it("rejects non-positive bounds", () => {
    const workspace = workspaceDir();
    const result = parseArgs([
      "--id",
      "t",
      "--intention",
      "i",
      "--definition-of-done",
      "d",
      "--workspace",
      workspace,
      "--builder",
      "--",
      "echo",
      "--max-attempts",
      "0",
    ]);
    assert.equal(result.ok, false);
  });

  it("rejects a missing workspace", () => {
    const result = parseArgs([
      "--id",
      "t",
      "--intention",
      "i",
      "--definition-of-done",
      "d",
      "--workspace",
      "/tmp/implementer-does-not-exist-xyz",
      "--builder",
      "--",
      "echo",
      "--max-attempts",
      "1",
    ]);
    assert.equal(result.ok, false);
  });

  it("refuses an invocation with no producer ceiling", () => {
    const result = parseArgs(args(["--builder", "--", "echo", "ok"]));
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.reason, /Missing required --builder-timeout-ms/);
  });

  it("refuses a Gate that carries no ceiling, because nothing else would bound it", () => {
    const result = parseArgs(
      args(["--builder-timeout-ms", "1000", "--gate", "lint", "--", "echo", "ok"]),
    );
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.reason, /Gate "lint" has no --gate-timeout-ms/);
  });

  it("reads a repair producer and its own ceiling", () => {
    const result = parseArgs(
      args([
        "--builder",
        "--",
        "echo",
        "build",
        "--repair-builder",
        "--",
        "echo",
        "repair",
        "--builder-timeout-ms",
        "1000",
        "--repair-builder-timeout-ms",
        "2000",
      ]),
    );
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.deepEqual(result.invocation.repairArgv, ["echo", "repair"]);
    assert.equal(result.invocation.repairTimeoutMs, 2000);
  });

  it("refuses a repair producer with nothing to fall back to", () => {
    const result = parseArgs(
      args(["--repair-builder", "--", "echo", "repair", "--builder-timeout-ms", "1000"]),
    );
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.reason, /needs a --builder to fall back to/);
  });

  it("parses --repair-gate independently of --gate", () => {
    const result = parseArgs(
      args([
        "--builder",
        "--",
        "echo",
        "build",
        "--repair-builder",
        "--",
        "echo",
        "repair",
        "--builder-timeout-ms",
        "1000",
        "--repair-builder-timeout-ms",
        "1000",
        "--gate-timeout-ms",
        "100",
        "--gate",
        "lint",
        "--",
        "node",
        "lint.js",
        "--repair-gate-timeout-ms",
        "100",
        "--repair-gate",
        "retest",
        "--",
        "node",
        "retest.js",
      ]),
    );
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.deepEqual(
      result.invocation.gates.map((g) => g.id),
      ["lint"],
    );
    assert.deepEqual(
      result.invocation.repairGates.map((g) => g.id),
      ["retest"],
    );
  });

  it("rejects duplicate repair Gate ids", () => {
    const result = parseArgs(
      args([
        "--builder",
        "--",
        "echo",
        "--repair-gate-timeout-ms",
        "1",
        "--repair-gate",
        "retest",
        "--",
        "echo",
        "--repair-gate-timeout-ms",
        "1",
        "--repair-gate",
        "retest",
        "--",
        "echo",
        "--builder-timeout-ms",
        "1000",
      ]),
    );
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.reason, /Duplicate repair Gate id "retest"/);
  });

  it("refuses a repair Gate that carries no ceiling, because nothing else would bound it", () => {
    const result = parseArgs(
      args(["--builder-timeout-ms", "1000", "--repair-gate", "retest", "--", "echo", "ok"]),
    );
    assert.equal(result.ok, false);
    assert.match(
      result.ok ? "" : result.reason,
      /Repair Gate "retest" has no --repair-gate-timeout-ms/,
    );
  });

  it("defaults repairGates to empty when no --repair-gate was given", () => {
    const result = parseArgs(
      args(["--builder", "--", "echo", "ok", "--builder-timeout-ms", "1000"]),
    );
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.deepEqual(result.invocation.repairGates, []);
  });
});
