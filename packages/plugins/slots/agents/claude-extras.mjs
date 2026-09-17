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
 * `skills` is `null` when stdout is not NDJSON we can parse; `[]` when parsed
 * with no Skill tool_use.
 */

import { readResult } from "@bluewombat/slot-kit";

/**
 * @param {string} stdout
 * @param {string} outputFormat
 * @returns {{ skills: string[] | null, usage: import("@bluewombat/slot-kit").AgentUsage | null }}
 */
export function extrasFromClaude(stdout, outputFormat) {
  return {
    skills: outputFormat === "stream-json" ? skillsFromClaude(stdout) : null,
    usage: usageFromClaude(stdout),
  };
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
