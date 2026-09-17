import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseArgs } from "./parse-args.js";

const required = [
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
];

describe("parseArgs", () => {
  it("parses a minimal valid invocation with --feature", () => {
    const result = parseArgs(["--feature", '{"key":"k"}', ...required]);
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.invocation.featureJson, '{"key":"k"}');
    assert.equal(result.invocation.maxFeatureBytes, 1000);
    assert.equal(result.invocation.maxUnits, 10);
    assert.deepEqual(result.invocation.plannerArgv, ["node", "planner.js"]);
    assert.equal(result.invocation.plannerDurationMs, 5000);
  });

  it("allows omitting --feature (stdin later)", () => {
    const result = parseArgs(required);
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.invocation.featureJson, undefined);
  });

  it("parses --on-status and --at", () => {
    const result = parseArgs([
      ...required,
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
    ]);
    assert.equal(result.ok, false);
  });

  it("rejects an unknown argument", () => {
    const result = parseArgs([...required, "--workspace", "/tmp"]);
    assert.equal(result.ok, false);
  });

  it("rejects a malformed --at", () => {
    const result = parseArgs([...required, "--at", "not-a-date"]);
    assert.equal(result.ok, false);
  });
});
