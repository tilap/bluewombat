/**
 * What both vendors' tool summaries share: the facts a stream yields once each
 * tool call has been read in that vendor's own shape. Vendor-free.
 */

import { isAbsolute, relative, resolve } from "node:path";

const URL_IN_TEXT = /https?:\/\/[^\s'"`<>|)\]]+/g;

/**
 * URLs a shell command names: `curl`, `wget` or a script reaching the web.
 * @param {unknown} command
 * @returns {string[]}
 */
export function urlsIn(command) {
  return typeof command === "string"
    ? [...command.matchAll(URL_IN_TEXT)].map((match) => match[0])
    : [];
}

/**
 * Whether a path a tool named is outside `cwd`. A skill file is not reported:
 * it is read from the plugin directories Mason itself points the agent at.
 * @param {unknown} path
 * @param {unknown} cwd
 * @returns {path is string}
 */
export function isOutside(path, cwd) {
  if (typeof path !== "string" || path.length === 0 || typeof cwd !== "string") {
    return false;
  }
  if (/(?:^|[/\\])skills[/\\][^/\\]+[/\\]SKILL\.md$/i.test(path)) {
    return false;
  }
  const absolute = isAbsolute(path) ? path : resolve(cwd, path);
  const fromCwd = relative(cwd, absolute);
  return fromCwd === ".." || fromCwd.startsWith(`..${"/"}`) || isAbsolute(fromCwd);
}

/**
 * Wall time covered by at least one `[start, end]` interval, in ms.
 * @param {[number, number][]} intervals
 * @returns {number}
 */
export function busyMs(intervals) {
  let total = 0;
  /** @type {[number, number] | undefined} */
  let current;
  for (const [start, end] of [...intervals].sort((a, b) => a[0] - b[0])) {
    if (current === undefined || start > current[1]) {
      if (current !== undefined) {
        total += current[1] - current[0];
      }
      current = [start, end];
    } else {
      current[1] = Math.max(current[1], end);
    }
  }
  return current === undefined ? total : total + current[1] - current[0];
}

/**
 * An empty summary, filled by a vendor's reader.
 * @returns {import("@bluewombat/slot-kit").AgentTools}
 */
export function emptyTools() {
  return { calls: {}, busyMs: null, web: [], mcp: [], subagents: [], outside: [] };
}

/**
 * One call more under `name`.
 * @param {import("@bluewombat/slot-kit").AgentTools} tools
 * @param {string} name
 */
export function count(tools, name) {
  tools.calls[name] = (tools.calls[name] ?? 0) + 1;
}
