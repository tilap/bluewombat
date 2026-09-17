import { type Dirent, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type ListResult = { ok: true; names: string[] } | { ok: false; detail: string };

/**
 * Names of regular files directly under the Source. Sub-directories, and
 * symlinks that do not resolve to a file, are not Events.
 */
export function listSource(source: string): ListResult {
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(source, { withFileTypes: true });
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }

  const names: string[] = [];
  for (const entry of entries) {
    if (entry.isFile()) {
      names.push(entry.name);
      continue;
    }
    if (!entry.isSymbolicLink()) {
      continue;
    }
    try {
      if (statSync(join(source, entry.name)).isFile()) {
        names.push(entry.name);
      }
    } catch {
      // A link pointing nowhere is not an Event.
    }
  }
  return { ok: true, names };
}
