/**
 * Extract mason AgentExtras from a Claude Code CLI stdout blob.
 *
 * Skills: stream-json assistant messages whose content has a `tool_use` named
 * `Skill` (Claude tools reference). The skill id is `input.skill` as emitted
 * by Claude Code (e.g. `planner:thin-slice`). Ignore `system/init.skills`
 * (available catalogue, not used).
 *
 * Usage: terminal `result` documents `usage` (`input_tokens`, …) and
 * `total_cost_usd`.
 *
 * Tools: every `tool_use` block of an assistant message, counted under its
 * `name`, as Claude Code's tools reference names them: `WebFetch` (`input.url`),
 * `WebSearch` (`input.query`), `Bash` (`input.command`), `Task` / `Agent`
 * (`input.description`), an MCP tool as `mcp__<server>__<tool>`, and
 * `file_path` / `path` on the file tools. The stream carries no times:
 * `busyMs` stays null.
 *
 * `skills` and `tools` are `null` when stdout is not NDJSON we can parse;
 * `skills` is `[]` when parsed with no Skill tool_use.
 */

import { readResult } from "@bluewombat/slot-kit";
import { count, emptyTools, isOutside, urlsIn } from "./tool-facts.mjs";

/**
 * @param {string} stdout
 * @param {string} outputFormat
 * @param {string} cwd the directory the agent worked in
 * @returns {import("@bluewombat/slot-kit").AgentExtras}
 */
export function extrasFromClaude(stdout, outputFormat, cwd) {
  const streamed = outputFormat === "stream-json";
  return {
    skills: streamed ? skillsFromClaude(stdout) : null,
    usage: usageFromClaude(stdout),
    tools: streamed ? toolsFromClaude(stdout, cwd) : null,
  };
}

/**
 * @param {string} stdout
 * @param {string} cwd the directory the agent worked in
 * @returns {import("@bluewombat/slot-kit").AgentTools | null}
 */
export function toolsFromClaude(stdout, cwd) {
  const tools = emptyTools();
  /** @type {Set<string>} */
  const seen = new Set();
  let parsedAny = false;
  for (const line of stdout.split("\n")) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event === null || typeof event !== "object" || Array.isArray(event)) {
      continue;
    }
    parsedAny = true;
    const content = event.type === "assistant" ? event.message?.content : undefined;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const block of content) {
      if (block?.type !== "tool_use" || typeof block.name !== "string") {
        continue;
      }
      // A partial-message stream repeats a block; its id says it once.
      if (typeof block.id === "string") {
        if (seen.has(block.id)) {
          continue;
        }
        seen.add(block.id);
      }
      const name = block.name;
      const input = block.input ?? {};
      count(tools, name);
      const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
      if (mcp !== null) {
        tools.mcp.push(`${mcp[1]}/${mcp[2]}`);
      } else if (name === "WebFetch" && typeof input.url === "string") {
        tools.web.push(input.url);
      } else if (name === "WebSearch" && typeof input.query === "string") {
        tools.web.push(`search: ${input.query}`);
      } else if (name === "Bash") {
        tools.web.push(...urlsIn(input.command).map((url) => `${url} (shell)`));
      } else if ((name === "Task" || name === "Agent") && typeof input.description === "string") {
        tools.subagents.push(input.description);
      }
      for (const path of [input.file_path, input.path, input.notebook_path]) {
        if (isOutside(path, cwd)) {
          tools.outside.push(path);
        }
      }
    }
  }
  return parsedAny ? tools : null;
}

/**
 * @param {string} stdout
 * @returns {string[] | null}
 */
export function skillsFromClaude(stdout) {
  const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return null;
  }
  /** @type {string[]} */
  const skills = [];
  /** @type {Set<string>} */
  const seen = new Set();
  let parsedAny = false;
  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event === null || typeof event !== "object" || Array.isArray(event)) {
      continue;
    }
    parsedAny = true;
    if (event.type !== "assistant") {
      continue;
    }
    const content = event.message?.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const block of content) {
      if (block === null || typeof block !== "object" || Array.isArray(block)) {
        continue;
      }
      if (block.type !== "tool_use" || block.name !== "Skill") {
        continue;
      }
      const input = block.input;
      if (input === null || typeof input !== "object" || Array.isArray(input)) {
        continue;
      }
      const name = /** @type {Record<string, unknown>} */ (input).skill;
      if (typeof name !== "string" || name.length === 0 || seen.has(name)) {
        continue;
      }
      seen.add(name);
      skills.push(name);
    }
  }
  return parsedAny ? skills : null;
}

/**
 * @param {string} stdout
 * @returns {import("@bluewombat/slot-kit").AgentUsage | null}
 */
export function usageFromClaude(stdout) {
  const result = readResult(stdout);
  if (result === undefined) {
    return null;
  }
  const usage = result.usage;
  if (usage === null || typeof usage !== "object" || Array.isArray(usage)) {
    return null;
  }
  const record = /** @type {Record<string, unknown>} */ (usage);
  if (
    typeof record.input_tokens !== "number" ||
    typeof record.output_tokens !== "number" ||
    typeof record.cache_creation_input_tokens !== "number" ||
    typeof record.cache_read_input_tokens !== "number"
  ) {
    return null;
  }
  return {
    input: record.input_tokens,
    output: record.output_tokens,
    cacheRead: record.cache_read_input_tokens,
    cacheWrite: record.cache_creation_input_tokens,
    costUsd: typeof result.total_cost_usd === "number" ? result.total_cost_usd : null,
  };
}
