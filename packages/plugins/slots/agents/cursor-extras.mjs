/**
 * Extract mason AgentExtras from a Cursor CLI stdout blob.
 *
 * Skills: documented stream-json `tool_call` / `readToolCall` with a path that
 * ends in `/skills/<name>/SKILL.md` (Cursor skills are SKILL.md files the
 * agent reads). Count each `call_id` once, on `started`.
 *
 * Usage: last JSON object (the terminal `result`) may carry a `usage` object
 * with camelCase token fields (observed; not in the published json schema).
 * No cost field is documented for Cursor — `costUsd` stays null.
 *
 * Tools: every `tool_call` (`<name>ToolCall`, args under it) counted once, on
 * `started`; its `completed` closes the interval for the busy time
 * (`timestamp_ms`). Observed on cursor-agent 2026.10.01: `webFetchToolCall`
 * (`args.url`), `mcpToolCall` (`args.providerIdentifier` / `args.toolName`),
 * `taskToolCall` (`args.description`), `shellToolCall` (`args.command`), and
 * `path` / `targetDirectory` on the file tools.
 *
 * `skills` and `tools` are `null` when the stdout is not NDJSON we can parse
 * (unknown); `skills` is `[]` when we parsed and found no skill reads.
 */

import { readResult } from "@bluewombat/slot-kit";
import { busyMs, count, emptyTools, isOutside, urlsIn } from "./tool-facts.mjs";

/**
 * @param {string} stdout
 * @param {string} outputFormat
 * @param {string} cwd the directory the agent worked in
 * @returns {import("@bluewombat/slot-kit").AgentExtras}
 */
export function extrasFromCursor(stdout, outputFormat, cwd) {
  const streamed = outputFormat === "stream-json";
  return {
    skills: streamed ? skillsFromCursor(stdout) : null,
    usage: usageFromCursor(stdout),
    tools: streamed ? toolsFromCursor(stdout, cwd) : null,
  };
}

/**
 * @param {string} stdout
 * @param {string} cwd the directory the agent worked in
 * @returns {import("@bluewombat/slot-kit").AgentTools | null}
 */
export function toolsFromCursor(stdout, cwd) {
  const tools = emptyTools();
  /** @type {Map<string, number>} */
  const open = new Map();
  /** @type {[number, number][]} */
  const intervals = [];
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
    if (
      event.type !== "tool_call" ||
      event.tool_call === null ||
      typeof event.tool_call !== "object"
    ) {
      continue;
    }
    const callId = typeof event.call_id === "string" ? event.call_id : "";
    const at = Number(event.timestamp_ms);
    if (event.subtype === "completed") {
      const started = open.get(callId);
      if (started !== undefined && Number.isFinite(at)) {
        intervals.push([started, at]);
      }
      open.delete(callId);
      continue;
    }
    if (event.subtype !== "started" || open.has(callId)) {
      continue;
    }
    if (Number.isFinite(at)) {
      open.set(callId, at);
    }
    const key = Object.keys(event.tool_call).find((name) => name.endsWith("ToolCall"));
    if (key === undefined) {
      continue;
    }
    const name = key.slice(0, -"ToolCall".length);
    const args = event.tool_call[key]?.args ?? {};
    count(tools, name);
    if (name === "webFetch" && typeof args.url === "string") {
      tools.web.push(args.url);
    } else if (name === "webSearch") {
      const term = args.searchTerm ?? args.query;
      if (typeof term === "string") {
        tools.web.push(`search: ${term}`);
      }
    } else if (name === "shell") {
      tools.web.push(...urlsIn(args.command).map((url) => `${url} (shell)`));
    } else if (name === "mcp") {
      tools.mcp.push(`${args.providerIdentifier ?? args.server ?? "?"}/${args.toolName ?? "?"}`);
    } else if (name === "task" && typeof args.description === "string") {
      tools.subagents.push(args.description);
    }
    for (const path of [args.path, args.targetDirectory]) {
      if (isOutside(path, cwd)) {
        tools.outside.push(path);
      }
    }
  }
  if (!parsedAny) {
    return null;
  }
  tools.busyMs = intervals.length === 0 ? null : busyMs(intervals);
  return tools;
}

/**
 * @param {string} stdout
 * @returns {string[] | null}
 */
export function skillsFromCursor(stdout) {
  const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return null;
  }
  /** @type {string[]} */
  const skills = [];
  /** @type {Set<string>} */
  const seenCalls = new Set();
  /** @type {Set<string>} */
  const seenNames = new Set();
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
    if (event.type !== "tool_call" || event.subtype !== "started") {
      continue;
    }
    const callId = typeof event.call_id === "string" ? event.call_id : "";
    if (callId.length > 0 && seenCalls.has(callId)) {
      continue;
    }
    const path = readToolPath(event.tool_call);
    const name = skillNameFromPath(path);
    if (name === undefined) {
      continue;
    }
    if (callId.length > 0) {
      seenCalls.add(callId);
    }
    if (seenNames.has(name)) {
      continue;
    }
    seenNames.add(name);
    skills.push(name);
  }
  return parsedAny ? skills : null;
}

/**
 * @param {unknown} toolCall
 * @returns {string | undefined}
 */
function readToolPath(toolCall) {
  if (toolCall === null || typeof toolCall !== "object" || Array.isArray(toolCall)) {
    return undefined;
  }
  const read = /** @type {Record<string, unknown>} */ (toolCall).readToolCall;
  if (read === null || typeof read !== "object" || Array.isArray(read)) {
    return undefined;
  }
  const args = /** @type {Record<string, unknown>} */ (read).args;
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return undefined;
  }
  const path = /** @type {Record<string, unknown>} */ (args).path;
  return typeof path === "string" ? path : undefined;
}

/**
 * @param {string | undefined} path
 * @returns {string | undefined}
 */
export function skillNameFromPath(path) {
  if (path === undefined) {
    return undefined;
  }
  const match = path.match(/(?:^|[/\\])skills[/\\]([^/\\]+)[/\\]SKILL\.md$/i);
  return match?.[1];
}

/**
 * @param {string} stdout
 * @returns {import("@bluewombat/slot-kit").AgentUsage | null}
 */
export function usageFromCursor(stdout) {
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
    typeof record.inputTokens !== "number" ||
    typeof record.outputTokens !== "number" ||
    typeof record.cacheReadTokens !== "number" ||
    typeof record.cacheWriteTokens !== "number"
  ) {
    return null;
  }
  return {
    input: record.inputTokens,
    output: record.outputTokens,
    cacheRead: record.cacheReadTokens,
    cacheWrite: record.cacheWriteTokens,
    costUsd: null,
  };
}
