import { createHash } from "node:crypto";
import { join } from "node:path";

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SLUG_KEEP = 48;

/**
 * One path segment for a key or an id. A plain one (`s1`, `fake-42`) is kept
 * as it is. Anything else — `github:tilap/site#1` — becomes a readable slug
 * plus a short hash of the original, so two keys never share a directory.
 *
 * No `%`, `:`, `/` or `#`: tools that run in the workspace (Vitest, Vite…)
 * refuse or mangle a path that looks URL-encoded.
 */
export function pathSegment(raw: string): string {
  if (SAFE_SEGMENT.test(raw) && raw.length <= SLUG_KEEP) {
    return raw;
  }
  const slug = raw
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, SLUG_KEEP)
    .replace(/[-._]+$/g, "");
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, 8);
  return slug === "" ? hash : `${slug}-${hash}`;
}

export function featureWorkspacePath(workspaceRoot: string, key: string): string {
  return join(workspaceRoot, pathSegment(key), "feature");
}

export function subtaskWorkspacePath(
  workspaceRoot: string,
  key: string,
  subtaskId: string,
): string {
  return join(workspaceRoot, pathSegment(key), `subtask-${pathSegment(subtaskId)}`);
}
