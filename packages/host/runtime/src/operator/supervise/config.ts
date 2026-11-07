import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { PRODUCT } from "@bluewombat/manager-kit";
import { parse as parseYaml } from "yaml";

export const SUPERVISOR_FILENAME = `${PRODUCT}.supervisor.yaml`;

/** A command with a ceiling. `{name}` in a word is filled by the supervisor. */
export type CommandSpec = { cmd: string[]; timeoutMs: number };

/** A repository the supervisor may change, and how a change reaches its line. */
export type FixTarget = {
  name: string;
  /** A checkout of the repository. The supervisor never edits it: it works in its own worktrees. */
  repo: string;
  base: string;
  remote: string;
  /** Run in the worktree after the agent. A change that does not pass is not offered. */
  checks: CommandSpec[];
  /** Offer the branch. Receives `{branch}` `{title}` `{bodyFile}`. Prints the pull request's reference. */
  open: CommandSpec;
  /**
   * Fold the offer without a person. Off unless the Project turns it on: by default the offer waits
   * for a person to read and merge it, and nothing that depends on it moves until then.
   */
  autoMerge: boolean;
  /** Fold the offer. Receives `{pr}`. Used only when `autoMerge` is on. */
  merge: CommandSpec;
  /** Whether the offer is folded yet. Receives `{pr}`. Exit 0 means folded. */
  merged: CommandSpec;
  /** After the fold: release, upgrade, restart. Receives `{branch}` `{title}`. */
  after: CommandSpec[];
  /** Paths the agent's change may not touch (prefixes). */
  deny: string[];
  /**
   * Where the repository writes down what it must be: the rules every member reads before it reasons
   * about a change, relative to `repo`. The first one is expected to route to the others.
   */
  rules: string[];
};

export type SupervisorConfig = {
  configDir: string;
  /** Where the supervisor keeps its own files, under Host's home. */
  dir: string;
  pollIntervalMs: number;
  /** Journal silent this long with work active is a stall. */
  stallAfterMs: number;
  /** An escalation younger than this is left to a person who may already be on it. 0: act at once. */
  settleMs: number;
  /** After acting, the same finding seen again is left this long to take effect. */
  cooldownMs: number;
  diskMinBytes: number;
  /** Attempts per finding before it is handed to a person. */
  maxAttempts: number;
  /** An agent per role. `{promptFile}` and `{prompt}` are filled. */
  agents: Record<string, CommandSpec>;
  worker: { start?: CommandSpec };
  /** Takes a resume signal to the tracker. Receives `{key}` `{number}`. */
  resume?: CommandSpec;
  diskCleanup: CommandSpec[];
  /** Tell a person. Receives `{subject}` `{file}`. Optional: the page is written either way. */
  notify?: CommandSpec;
  targets: FixTarget[];
};

export const ROLES = ["rootcause", "remedy", "skeptic", "arbiter", "fixer", "reviewer"] as const;
export type Role = (typeof ROLES)[number];

export type LoadedConfig = { ok: true; config: SupervisorConfig } | { ok: false; reason: string };

const DEFAULT_AGENT_MS = 20 * 60_000;

/**
 * Claude Code, headless. The analysts read and do not write; the fixer works in
 * a worktree of its own and may. The prompt comes before `--add-dir`, which takes
 * every value after it and would swallow the prompt as a directory.
 */
function claude(mode: "plan" | "bypassPermissions", model: string): CommandSpec {
  return {
    cmd: ["claude", "-p", "{prompt}", "--model", model, "--permission-mode", mode, "{addDirArgs}"],
    timeoutMs: DEFAULT_AGENT_MS,
  };
}

export function findSupervisorConfig(from: string): string | undefined {
  let dir = resolve(from);
  for (;;) {
    const candidate = join(dir, SUPERVISOR_FILENAME);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

export function loadSupervisorConfig(path: string, home: string): LoadedConfig {
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, "utf8"));
  } catch (error) {
    return { ok: false, reason: `${path}: ${error instanceof Error ? error.message : error}` };
  }
  const object = (raw ?? {}) as Record<string, unknown>;
  if (typeof object !== "object" || Array.isArray(object)) {
    return { ok: false, reason: `${path} must be a YAML mapping.` };
  }
  const configDir = dirname(path);
  try {
    return { ok: true, config: build(object, configDir, home) };
  } catch (error) {
    return { ok: false, reason: `${path}: ${error instanceof Error ? error.message : error}` };
  }
}

function build(o: Record<string, unknown>, configDir: string, home: string): SupervisorConfig {
  const agents: Record<string, CommandSpec> = {
    rootcause: claude("plan", "opus"),
    remedy: claude("plan", "opus"),
    skeptic: claude("plan", "opus"),
    arbiter: claude("plan", "opus"),
    fixer: claude("bypassPermissions", "opus"),
    reviewer: claude("plan", "opus"),
  };
  for (const [role, value] of Object.entries(map(o.agents, "agents"))) {
    if (!(ROLES as readonly string[]).includes(role)) {
      throw new Error(`agents.${role}: no such role (${ROLES.join(", ")}).`);
    }
    agents[role] = command(value, `agents.${role}`, DEFAULT_AGENT_MS);
  }
  const worker = map(o.worker, "worker");
  const targets = Object.entries(map(o.targets, "targets")).map(([name, value]) =>
    target(name, map(value, `targets.${name}`), configDir),
  );
  return {
    configDir,
    dir: resolve(configDir, text(o.dir) ?? join(home, "supervisor")),
    pollIntervalMs: num(o.pollIntervalMs, "pollIntervalMs", 15_000),
    stallAfterMs: num(o.stallAfterMs, "stallAfterMs", 20 * 60_000),
    settleMs: num(o.settleMs, "settleMs", 0),
    cooldownMs: num(o.cooldownMs, "cooldownMs", 5 * 60_000),
    diskMinBytes: num(o.diskMinBytes, "diskMinBytes", 3 * 1024 ** 3),
    maxAttempts: num(o.maxAttempts, "maxAttempts", 3),
    agents,
    worker:
      worker.start === undefined ? {} : { start: command(worker.start, "worker.start", 30_000) },
    ...(o.resume === undefined ? {} : { resume: command(o.resume, "resume", 60_000) }),
    diskCleanup: list(o.diskCleanup, "diskCleanup").map((c, i) =>
      command(c, `diskCleanup[${i}]`, 10 * 60_000),
    ),
    ...(o.notify === undefined ? {} : { notify: command(o.notify, "notify", 60_000) }),
    targets,
  };
}

function target(name: string, o: Record<string, unknown>, configDir: string): FixTarget {
  const where = `targets.${name}`;
  const repo = text(o.repo);
  if (repo === undefined) {
    throw new Error(`${where}.repo is required.`);
  }
  return {
    name,
    repo: resolve(configDir, repo),
    base: text(o.base) ?? "main",
    remote: text(o.remote) ?? "origin",
    checks: list(o.checks, `${where}.checks`).map((c, i) =>
      command(c, `${where}.checks[${i}]`, 30 * 60_000),
    ),
    open: command(
      o.open ?? {
        cmd: [
          "gh",
          "pr",
          "create",
          "--head",
          "{branch}",
          "--title",
          "{title}",
          "--body-file",
          "{bodyFile}",
        ],
      },
      `${where}.open`,
      120_000,
    ),
    autoMerge: o.autoMerge === true,
    merge: command(
      o.merge ?? { cmd: ["gh", "pr", "merge", "{pr}", "--squash", "--auto"] },
      `${where}.merge`,
      120_000,
    ),
    merged: command(
      o.merged ?? {
        cmd: [
          "sh",
          "-c",
          'test "$(gh pr view "$1" --json state -q .state)" = MERGED',
          "sh",
          "{pr}",
        ],
      },
      `${where}.merged`,
      60_000,
    ),
    after: list(o.after, `${where}.after`).map((c, i) =>
      command(c, `${where}.after[${i}]`, 30 * 60_000),
    ),
    deny: list(o.deny, `${where}.deny`).map((d) => String(d)),
    rules: o.rules === undefined ? ["AGENTS.md"] : list(o.rules, `${where}.rules`).map(String),
  };
}

function command(value: unknown, where: string, fallbackMs: number): CommandSpec {
  const o = Array.isArray(value) ? { cmd: value } : map(value, where);
  const cmd = o.cmd;
  if (!Array.isArray(cmd) || cmd.length === 0 || cmd.some((w) => typeof w !== "string")) {
    throw new Error(`${where}.cmd must be a non-empty list of strings.`);
  }
  return { cmd: cmd as string[], timeoutMs: num(o.timeoutMs, `${where}.timeoutMs`, fallbackMs) };
}

function map(value: unknown, where: string): Record<string, unknown> {
  if (value === undefined || value === null) {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${where} must be a mapping.`);
  }
  return value as Record<string, unknown>;
}

function list(value: unknown, where: string): unknown[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${where} must be a list.`);
  }
  return value;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown, where: string, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${where} must be a number of zero or more.`);
  }
  return value;
}
