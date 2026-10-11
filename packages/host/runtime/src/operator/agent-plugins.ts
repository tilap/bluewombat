import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Finding } from "@bluewombat/manager-kit";
import { agentPartOf } from "../config/agent-shorthand.js";

/**
 * What an agent pass will start its agent with, checked from the files alone.
 *
 * `--plugin-dir` folders are the operator's, so they must be there now. A
 * `--profile` is the project's: its requests and locks are read in the work
 * line as it was last refreshed, the way the agent wrapper reads them in a
 * workspace cut from it. Building the profile is `deck materialize`'s job and
 * may fetch, so it is not done here — doctor stays offline. What is checked is
 * what makes every attempt of a role fail the same way: a request no committed
 * lock pins.
 */
export function agentPluginFindings(
  label: string,
  argv: readonly string[],
  workLine: string | undefined,
): Finding[] {
  const part = agentPartOf(argv);
  const findings: Finding[] = [];
  for (const dir of part.pluginDirs) {
    findings.push(pluginDirFinding(label, dir));
  }
  if (part.profile !== undefined) {
    findings.push(profileFinding(label, part.profile, workLine));
  }
  return findings;
}

function pluginDirFinding(label: string, dir: string): Finding {
  const at = `${label} plugin`;
  if (!isDirectory(dir)) {
    return { level: "fail", label: at, detail: `not a folder: ${dir}` };
  }
  const missing = [".claude-plugin/plugin.json", ".cursor-plugin/plugin.json"].filter(
    (manifest) => !existsSync(join(dir, manifest)),
  );
  if (missing.length > 0) {
    return {
      level: "warn",
      label: at,
      detail: `${dir} has no ${missing.join(" nor ")} — the host that needs it will not load it`,
    };
  }
  return { level: "ok", label: at, detail: dir };
}

function profileFinding(label: string, profile: string, workLine: string | undefined): Finding {
  const at = `${label} profile`;
  if (workLine === undefined || !isDirectory(workLine)) {
    return {
      level: "ok",
      label: at,
      detail: `${profile} — read from the project once the work line exists`,
    };
  }
  const base = requestsOf(join(workLine, "ai-plugin.json"));
  const profileRoot = join(workLine, ".ai", "profiles", profile);
  const own = requestsOf(join(profileRoot, "ai-plugin.json"));
  if (base === undefined && own === undefined) {
    return {
      level: "ok",
      label: at,
      detail: `${profile} — the project has no deck setup: only the local plugins load`,
    };
  }
  const unpinned = [
    ...unpinnedIn(base, join(workLine, "ai-plugin.lock.json")),
    ...unpinnedIn(own, join(profileRoot, "ai-plugin.lock.json")),
  ];
  if (unpinned.length > 0) {
    return {
      level: "fail",
      label: at,
      detail: `${profile} — ${unpinned.join("; ")}. Run deck install in the project and commit its locks, or every attempt of this role refuses`,
    };
  }
  if (own === undefined) {
    return {
      level: "warn",
      label: at,
      detail: `${profile} — the project has no such deck profile: the base plugins only`,
    };
  }
  return {
    level: "ok",
    label: at,
    detail: `${profile} — ${(base?.length ?? 0) + own.length} plugin(s) pinned (base and profile)`,
  };
}

type Request = { id: string | undefined };

/** The requests of one `ai-plugin.json`; `undefined` when there is none. */
function requestsOf(file: string): Request[] | undefined {
  if (!existsSync(file)) {
    return undefined;
  }
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { plugins?: unknown };
    if (!Array.isArray(raw.plugins)) {
      return [];
    }
    return raw.plugins.map((entry: unknown) => {
      const id = (entry as { id?: unknown } | null)?.id;
      return { id: typeof id === "string" ? id : undefined };
    });
  } catch {
    return [{ id: undefined }];
  }
}

/**
 * Why `requests` are not all pinned by `lockFile`, as deck would refuse them.
 * A request whose id deck derives from its source is counted, not named.
 */
function unpinnedIn(requests: Request[] | undefined, lockFile: string): string[] {
  if (requests === undefined || requests.length === 0) {
    return [];
  }
  if (!existsSync(lockFile)) {
    return [`no committed ${relativeName(lockFile)} for ${requests.length} request(s)`];
  }
  let pinned: Set<string>;
  let pinnedCount: number;
  try {
    const raw = JSON.parse(readFileSync(lockFile, "utf8")) as { plugins?: unknown };
    const entries = Array.isArray(raw.plugins) ? raw.plugins : [];
    const ids = entries
      .filter((entry: unknown) => typeof (entry as { integrity?: unknown })?.integrity === "string")
      .map((entry: unknown) => String((entry as { id?: unknown }).id));
    pinned = new Set(ids);
    pinnedCount = ids.length;
  } catch {
    return [`${relativeName(lockFile)} is not valid JSON`];
  }
  const named = requests.flatMap((request) =>
    request.id !== undefined && !pinned.has(request.id) ? [request.id] : [],
  );
  if (named.length > 0) {
    return [`${named.join(", ")} not pinned by ${relativeName(lockFile)}`];
  }
  if (pinnedCount < requests.length) {
    return [`${relativeName(lockFile)} pins ${pinnedCount} of ${requests.length} request(s)`];
  }
  return [];
}

function relativeName(file: string): string {
  const at = file.lastIndexOf("/.ai/profiles/");
  return at === -1 ? "ai-plugin.lock.json" : file.slice(at + 1);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
