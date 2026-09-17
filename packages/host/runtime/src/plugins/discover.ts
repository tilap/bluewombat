import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { PRODUCT } from "@bluewombat/manager-kit";

/** What a package says about itself to be offered by `mason init`. */
const MANAGER_KEYWORD = `${PRODUCT}-manager`;

export type DiscoveredManager = { name: string; description?: string };

/**
 * The manager packages installed near `fromDir`.
 *
 * Host has no list of trackers and must not grow one: a package is a manager
 * because it says so in its own keywords, so a third-party one is found the
 * same way the two shipped here are.
 */
export function discoverManagers(fromDir: string): DiscoveredManager[] {
  const found = new Map<string, DiscoveredManager>();
  let dir = resolve(fromDir);
  for (;;) {
    const modules = join(dir, "node_modules");
    if (existsSync(modules)) {
      for (const entry of safeList(modules)) {
        if (entry.startsWith("@")) {
          for (const scoped of safeList(join(modules, entry))) {
            record(found, join(modules, entry, scoped));
          }
          continue;
        }
        record(found, join(modules, entry));
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return [...found.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function safeList(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function record(found: Map<string, DiscoveredManager>, packageRoot: string): void {
  const manifest = join(packageRoot, "package.json");
  try {
    if (!statSync(manifest).isFile()) {
      return;
    }
  } catch {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifest, "utf8"));
  } catch {
    return;
  }
  if (parsed === null || typeof parsed !== "object") {
    return;
  }
  const data = parsed as { name?: unknown; description?: unknown; keywords?: unknown };
  if (typeof data.name !== "string" || !Array.isArray(data.keywords)) {
    return;
  }
  if (!data.keywords.includes(MANAGER_KEYWORD)) {
    return;
  }
  // The nearest copy wins, the way an import would resolve it.
  if (found.has(data.name)) {
    return;
  }
  found.set(data.name, {
    name: data.name,
    ...(typeof data.description === "string" ? { description: data.description } : {}),
  });
}
