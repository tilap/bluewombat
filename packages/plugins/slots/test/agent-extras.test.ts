import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  extrasFromClaude,
  skillsFromClaude,
  toolsFromClaude,
  usageFromClaude,
} from "../agents/claude-extras.mjs";
import {
  extrasFromCursor,
  skillNameFromPath,
  skillsFromCursor,
  toolsFromCursor,
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
    assert.equal(extrasFromCursor(stdout, "json", "/work").skills, null);
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
    assert.equal(extrasFromClaude(stdout, "json", "/work").skills, null);
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

describe("toolsFromCursor", () => {
  // Shapes taken from real cursor-agent streams: a WebFetch probe and issue
  // #11 of tilap/orangemonkey-site (MCP reads, three subagents).
  const stdout = readFileSync(join(fixtures, "cursor-stream-tools.jsonl"), "utf8");
  const tools = toolsFromCursor(stdout, "/work/feature");

  it("counts every call once, under the tool's own name", () => {
    assert.equal(tools?.calls.webFetch, 2);
    assert.equal(tools?.calls.mcp, 2);
    assert.equal(tools?.calls.task, 3);
    assert.equal(tools?.calls.shell, 2);
    assert.equal(typeof tools?.busyMs, "number");
  });

  it("names the pages fetched, including through a shell", () => {
    assert.deepEqual(tools?.web, [
      "https://example.com",
      "https://example.com (shell)",
      "https://example.com (shell)",
      "https://example.com",
    ]);
  });

  it("names MCP calls, subagents, and reads outside the workspace", () => {
    assert.deepEqual(tools?.mcp, ["github/issue_read", "github/issue_read"]);
    assert.deepEqual(tools?.subagents, [
      "RSS XSLT human-readable",
      "Vitest RSS XSLT proofs",
      "Slice review RSS XSLT",
    ]);
    // A skill read from Mason's plugin directory is expected, not reported.
    assert.deepEqual(tools?.outside, ["/home/someone/.config/notes.md"]);
  });

  it("counts a getMcpTools catalogue read in the mcp list", () => {
    const discovered = JSON.stringify({
      type: "tool_call",
      subtype: "started",
      call_id: "call-discover",
      tool_call: { getMcpToolsToolCall: { args: { server: "github" } } },
      timestamp_ms: 1,
    });
    const unnamed = JSON.stringify({
      type: "tool_call",
      subtype: "started",
      call_id: "call-discover-all",
      tool_call: { getMcpToolsToolCall: { args: {} } },
      timestamp_ms: 2,
    });
    const discoveredTools = toolsFromCursor(`${discovered}\n${unnamed}\n`, "/work");
    assert.equal(discoveredTools?.calls.getMcpTools, 2);
    assert.deepEqual(discoveredTools?.mcp, ["github/getMcpTools", "getMcpTools"]);
  });

  it("is unknown when nothing is JSON, or not a stream", () => {
    assert.equal(toolsFromCursor("not json", "/work"), null);
    assert.equal(extrasFromCursor(stdout, "json", "/work/feature").tools, null);
  });
});

describe("toolsFromClaude", () => {
  const stdout = readFileSync(join(fixtures, "claude-stream-tools.jsonl"), "utf8");
  const tools = toolsFromClaude(stdout, "/work/feature");

  it("counts tool_use blocks once each, by name", () => {
    assert.deepEqual(tools?.calls, {
      Skill: 1,
      Read: 2,
      WebFetch: 1,
      WebSearch: 1,
      Bash: 1,
      mcp__github__issue_read: 1,
      Task: 1,
    });
    // Claude's stream carries no times.
    assert.equal(tools?.busyMs, null);
  });

  it("names pages, searches, MCP calls, subagents, and reads outside", () => {
    assert.deepEqual(tools?.web, [
      "https://example.com/xslt",
      "search: rss xslt stylesheet",
      "https://example.com/feed.xml (shell)",
    ]);
    assert.deepEqual(tools?.mcp, ["github/issue_read"]);
    assert.deepEqual(tools?.subagents, ["Slice review RSS XSLT"]);
    assert.deepEqual(tools?.outside, ["/home/someone/.config/notes.md"]);
  });

  it("is unknown when nothing is JSON, or not a stream", () => {
    assert.equal(toolsFromClaude("plain text", "/work"), null);
    assert.equal(extrasFromClaude(stdout, "json", "/work/feature").tools, null);
  });
});
