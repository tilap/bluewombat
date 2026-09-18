import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { extrasFromClaude, skillsFromClaude, usageFromClaude } from "../agents/claude-extras.mjs";
import {
  extrasFromCursor,
  skillNameFromPath,
  skillsFromCursor,
  usageFromCursor,
} from "../agents/cursor-extras.mjs";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

describe("skillsFromCursor", () => {
  it("reads skill names from readToolCall paths in a captured stream", () => {
    const stdout = readFileSync(join(fixtures, "cursor-stream-skills.jsonl"), "utf8");
    assert.deepEqual(skillsFromCursor(stdout), ["thin-slice"]);
  });

  it("returns [] when NDJSON has no skill reads", () => {
    const stdout = [
      '{"type":"system","subtype":"init"}',
      '{"type":"result","subtype":"success","is_error":false,"result":"ok"}',
    ].join("\n");
    assert.deepEqual(skillsFromCursor(stdout), []);
  });

  it("returns null when nothing is JSON", () => {
    assert.equal(skillsFromCursor("not json\nalso not\n"), null);
  });

  it("does not count skills when output format is not stream-json", () => {
    const stdout = readFileSync(join(fixtures, "cursor-stream-skills.jsonl"), "utf8");
    assert.equal(extrasFromCursor(stdout, "json").skills, null);
  });
});

describe("skillNameFromPath", () => {
  it("takes the directory under skills/", () => {
    assert.equal(skillNameFromPath("/x/skills/thin-slice/SKILL.md"), "thin-slice");
  });

  it("rejects paths that are not a SKILL.md under skills/", () => {
    assert.equal(skillNameFromPath("/x/skills/thin-slice/README.md"), undefined);
    assert.equal(skillNameFromPath("/x/thin-slice/SKILL.md"), undefined);
  });
});

describe("usageFromCursor", () => {
  it("maps camelCase usage from the terminal result", () => {
    const stdout = readFileSync(join(fixtures, "cursor-stream-skills.jsonl"), "utf8");
    assert.deepEqual(usageFromCursor(stdout), {
      input: 10077,
      output: 436,
      cacheRead: 26624,
      cacheWrite: 0,
      costUsd: null,
    });
  });
});

describe("skillsFromClaude", () => {
  it("reads Skill tool_use input.skill from a captured stream", () => {
    const stdout = readFileSync(join(fixtures, "claude-stream-skills.jsonl"), "utf8");
    assert.deepEqual(skillsFromClaude(stdout), ["planner:thin-slice"]);
  });

  it("ignores system/init.skills (available catalogue)", () => {
    const stdout = [
      '{"type":"system","subtype":"init","skills":["planner:thin-slice"]}',
      '{"type":"result","subtype":"success","result":"ok"}',
    ].join("\n");
    assert.deepEqual(skillsFromClaude(stdout), []);
  });

  it("returns null when nothing is JSON", () => {
    assert.equal(skillsFromClaude("plain text"), null);
  });

  it("does not count skills when output format is not stream-json", () => {
    const stdout = readFileSync(join(fixtures, "claude-stream-skills.jsonl"), "utf8");
    assert.equal(extrasFromClaude(stdout, "json").skills, null);
  });
});

describe("usageFromClaude", () => {
  it("maps snake_case usage and total_cost_usd from the terminal result", () => {
    const stdout = readFileSync(join(fixtures, "claude-stream-skills.jsonl"), "utf8");
    assert.deepEqual(usageFromClaude(stdout), {
      input: 4,
      output: 62,
      cacheRead: 0,
      cacheWrite: 51140,
      costUsd: 0.30841699999999994,
    });
  });
});
