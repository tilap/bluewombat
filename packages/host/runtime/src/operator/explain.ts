import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { CLI_NAME } from "@bluewombat/manager-kit";
import { parseAppDeckProfile } from "../config/agent-shorthand.js";
import { parseArgs } from "../config/parse-args.js";
import {
  type GatedPassSpec,
  type HostInvocation,
  hasAgent,
  type ReviewSpec,
} from "../config/types.js";
import type { WorkLineResolution } from "../loop/work-line.js";
import { loadManagerModule, requestOf } from "../plugins/manager.js";
import { isDirectory, requestsOf, unpinnedIn } from "./agent-plugins.js";
import { workLineOf } from "./doctor.js";

export type ExplainInput = {
  cwd: string;
  argv: string[];
  env: Record<string, string | undefined>;
  write: (text: string) => void;
};

/** Where a plugin comes from: the operator's home, or the project's deck. */
export type Layer = "home" | "base" | "profile";

export type Note = { level: "warn" | "fail"; text: string };

/** One plugin an agent starts with. `undefined` means "not known", never "none". */
export type PluginReport = {
  layer: Layer;
  id: string;
  source: string;
  skills?: string[];
  agents?: string[];
  commands?: string[];
  hooks?: boolean;
  mcp?: string[];
  note?: string;
};

export type RoleReport = {
  role: string;
  kind: "agent" | "command";
  command?: string[];
  agent?: {
    adapter: string;
    model?: string;
    home?: string;
    apiKeyEnv?: string;
    apiKeySet?: boolean;
    denyShell: string[];
  };
  timeoutMs: number;
  maxAttempts?: number;
  prompt?: {
    file?: string;
    placeholders: string[];
    rulesFile?: string;
  };
  project?: {
    state: "read" | "not-yet" | "no-deck" | "invalid";
    profile: string;
    path?: string;
    commit?: string;
    date?: string;
    promptFile?: string;
    promptText?: string;
  };
  plugins: PluginReport[];
  gates: string[];
  notes: Note[];
};

/**
 * What each role's slot fills in its prompt, and what the prompt must place.
 *
 * It mirrors the `fillPrompt` call of each slot, which refuses an unknown name
 * and a missing required one on every attempt. A test reads the slots' own
 * sources and fails when this table drifts from them.
 */
export const PROMPT_PLACEHOLDERS: Record<
  string,
  { known: readonly string[]; required: readonly string[] }
> = {
  "builder.producer": {
    known: ["task", "history", "rules", "id", "attempt"],
    required: ["task", "rules"],
  },
  "builder.tests": {
    known: ["task", "history", "rules", "id", "attempt"],
    required: ["task", "rules"],
  },
  "builder.e2e": {
    known: ["task", "history", "refusal", "report", "refused_by", "rules", "id", "attempt"],
    required: ["task", "rules"],
  },
  "builder.repair": {
    known: ["task", "history", "report", "refused_by", "rules", "id", "attempt"],
    required: ["task", "report", "rules"],
  },
  "ticket.fix": {
    known: ["task", "history", "report", "refused_by", "rules", "id", "attempt"],
    required: ["task", "report", "rules"],
  },
  "feature.fix": {
    known: ["task", "history", "report", "refused_by", "rules", "id", "attempt"],
    required: ["task", "report", "rules"],
  },
  "ticket.validate": {
    known: ["task", "rules", "id", "attempt"],
    required: ["task", "rules"],
  },
  "feature.validate": {
    known: ["task", "rules", "id", "attempt"],
    required: ["task", "rules"],
  },
  "authority.describe": {
    known: ["title", "intention", "target", "id", "rules", "out"],
    required: ["title", "out"],
  },
};

/** The lock format whose `components` this command knows how to read. */
const KNOWN_LOCK_VERSION = 3;

const NOT_COVERED = [
  "The prompt of a given ticket: {{task}} and {{history}} are filled at run time (see the transcripts).",
  "What the agent's own tool reads from the checkout on its own (AGENTS.md, rules, repository hooks).",
];

type RoleDef = {
  role: string;
  cmd: string[];
  timeoutMs: number;
  maxAttempts?: number;
  gates: string[];
};

function rolesOf(invocation: HostInvocation): RoleDef[] {
  const roles: RoleDef[] = [];
  const add = (
    role: string,
    pass: { cmd: string[]; timeoutMs: number; gates?: { id: string }[] } | undefined,
    maxAttempts: number | undefined,
  ): void => {
    if (pass === undefined) {
      return;
    }
    roles.push({
      role,
      cmd: pass.cmd,
      timeoutMs: pass.timeoutMs,
      ...(maxAttempts === undefined ? {} : { maxAttempts }),
      gates: (pass.gates ?? []).map((gate) => gate.id),
    });
  };
  const withAgent = (review: ReviewSpec | undefined): GatedPassSpec | undefined =>
    review !== undefined && hasAgent(review) ? review : undefined;
  add("builder.tests", withAgent(invocation.builder.tests), invocation.builder.maxAttempts);
  add("builder.e2e", invocation.builder.e2e, invocation.builder.maxAttempts);
  add("builder.producer", invocation.builder.producer, invocation.builder.maxAttempts);
  add("builder.repair", invocation.builder.repair, invocation.builder.maxAttempts);
  add("ticket.fix", invocation.ticket.fix, invocation.ticket.maxAttempts);
  add("ticket.validate", withAgent(invocation.ticket.validate), invocation.ticket.maxAttempts);
  add("feature.fix", invocation.feature?.fix, invocation.feature?.maxAttempts);
  add(
    "feature.validate",
    invocation.feature === undefined ? undefined : withAgent(invocation.feature.validate),
    invocation.feature?.maxAttempts,
  );
  if (invocation.authority?.describeArgv !== undefined) {
    add(
      "authority.describe",
      { cmd: invocation.authority.describeArgv, timeoutMs: invocation.timeoutMs },
      undefined,
    );
  }
  return roles;
}

function allValues(tokens: readonly string[], flag: string): string[] {
  const found: string[] = [];
  tokens.forEach((token, at) => {
    const value = tokens[at + 1];
    if (token === flag && value !== undefined) {
      found.push(value);
    }
  });
  return found;
}

function firstValue(tokens: readonly string[], flag: string): string | undefined {
  return allValues(tokens, flag)[0];
}

/** `--model X`, written as two `--agent-arg` values or directly. */
function modelOf(agent: readonly string[]): string | undefined {
  const args = allValues(agent, "--agent-arg");
  const at = args.indexOf("--model");
  if (at !== -1) {
    return args[at + 1];
  }
  const direct = firstValue(agent, "--model");
  return direct === undefined || direct.startsWith("-") ? undefined : direct;
}

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function names(dir: string, keep: (entry: string) => boolean): string[] | undefined {
  try {
    return readdirSync(dir)
      .filter((entry) => !entry.startsWith("."))
      .filter(keep)
      .sort();
  } catch {
    return undefined;
  }
}

/** A plugin folder of the operator's, read as it is now. */
function homePlugin(dir: string, notes: Note[]): PluginReport {
  if (!isDirectory(dir)) {
    notes.push({ level: "fail", text: `the plugin folder ${dir} does not exist` });
    return { layer: "home", id: basename(dir), source: dir, note: "not a folder" };
  }
  const manifests = [".claude-plugin/plugin.json", ".cursor-plugin/plugin.json"];
  const missing = manifests.filter((manifest) => !existsSync(join(dir, manifest)));
  if (missing.length > 0) {
    notes.push({
      level: "warn",
      text: `${dir} has no ${missing.join(" nor ")}: the host that needs it will not load it`,
    });
  }
  let id = basename(dir);
  for (const manifest of [...manifests, "plugin.json"]) {
    const text = readText(join(dir, manifest));
    try {
      const name = (JSON.parse(text ?? "{}") as { name?: unknown }).name;
      if (typeof name === "string" && name.length > 0) {
        id = name;
        break;
      }
    } catch {
      // A manifest that does not parse is `doctor`'s to report; the folder name stands in.
    }
  }
  const mcpText = readText(join(dir, ".mcp.json"));
  let mcp: string[] = [];
  try {
    const servers = (JSON.parse(mcpText ?? "{}") as { mcpServers?: Record<string, unknown> })
      .mcpServers;
    mcp = servers === undefined ? [] : Object.keys(servers);
  } catch {
    mcp = [];
  }
  return {
    layer: "home",
    id,
    source: dir,
    skills:
      names(join(dir, "skills"), (entry) => existsSync(join(dir, "skills", entry, "SKILL.md"))) ??
      [],
    agents: (names(join(dir, "agents"), (entry) => entry.endsWith(".md")) ?? []).map((entry) =>
      entry.replace(/\.md$/, ""),
    ),
    commands: (names(join(dir, "commands"), (entry) => entry.endsWith(".md")) ?? []).map((entry) =>
      entry.replace(/\.md$/, ""),
    ),
    hooks: existsSync(join(dir, "hooks", "hooks.json")),
    mcp,
  };
}

type LockEntry = {
  id?: unknown;
  request?: { source?: unknown; plugin?: unknown; ref?: unknown };
  resolved?: { sha?: unknown };
  components?: {
    skills?: unknown;
    agents?: unknown;
    commands?: unknown;
    hooks?: unknown;
    mcp?: unknown;
  };
};

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? (value as string[])
    : undefined;
}

/** The plugins a deck lock pins, with what each brings, from the lock alone. */
function lockPlugins(lockFile: string, layer: Layer, notes: Note[]): PluginReport[] {
  const text = readText(lockFile);
  if (text === undefined) {
    return [];
  }
  let lock: { lockfileVersion?: unknown; plugins?: unknown };
  try {
    lock = JSON.parse(text) as typeof lock;
  } catch {
    return [];
  }
  const supported = lock.lockfileVersion === KNOWN_LOCK_VERSION;
  if (!supported) {
    notes.push({
      level: "warn",
      text: `${basename(lockFile)} is lockfileVersion ${String(lock.lockfileVersion)}, not ${KNOWN_LOCK_VERSION}: what its plugins bring is not shown`,
    });
  }
  const entries = Array.isArray(lock.plugins) ? (lock.plugins as LockEntry[]) : [];
  return entries.map((entry) => {
    const request = entry.request ?? {};
    const sha =
      typeof entry.resolved?.sha === "string" ? entry.resolved.sha.slice(0, 7) : undefined;
    const source = [
      typeof request.source === "string" ? request.source : "unknown source",
      typeof request.plugin === "string" ? `@${request.plugin}` : "",
      typeof request.ref === "string" ? ` @ ${request.ref}` : "",
      sha === undefined ? "" : ` (${sha})`,
    ].join("");
    const report: PluginReport = {
      layer,
      id: typeof entry.id === "string" ? entry.id : "(no id)",
      source,
    };
    const components = entry.components;
    if (!supported || components === undefined) {
      report.note = "contents not known";
      return report;
    }
    const skills = strings(components.skills);
    const agents = strings(components.agents);
    const commands = strings(components.commands);
    const mcp = strings(components.mcp);
    if (skills !== undefined) report.skills = skills;
    if (agents !== undefined) report.agents = agents.map((agent) => agent.replace(/\.md$/, ""));
    if (commands !== undefined) report.commands = commands.map((c) => c.replace(/\.md$/, ""));
    if (typeof components.hooks === "boolean") report.hooks = components.hooks;
    if (mcp !== undefined) report.mcp = mcp;
    return report;
  });
}

function gitHead(dir: string): { commit: string; date: string } | undefined {
  if (!existsSync(join(dir, ".git"))) {
    return undefined;
  }
  // A local read of one commit: no timeout, because a timeout on a synchronous
  // spawn does not end the tree (scripts/check-process-tree.mjs).
  const run = spawnSync("git", ["-C", dir, "log", "-1", "--format=%h %cI"], {
    encoding: "utf8",
  });
  if (run.status !== 0) {
    return undefined;
  }
  const [commit, date] = run.stdout.trim().split(" ");
  return commit === undefined || date === undefined ? undefined : { commit, date };
}

/** The project's side of a role: its deck setup in the work line, as last refreshed. */
function projectOf(
  profile: string,
  workLine: WorkLineResolution,
  notes: Note[],
): { project: NonNullable<RoleReport["project"]>; plugins: PluginReport[] } {
  const located = parseAppDeckProfile(profile);
  const none = (state: "not-yet" | "invalid", path?: string) => ({
    project: { state, profile, ...(path === undefined ? {} : { path }) },
    plugins: [] as PluginReport[],
  });
  if (workLine.kind === "invalid") {
    notes.push({ level: "fail", text: `the work line is invalid: ${workLine.reason}` });
    return none("invalid");
  }
  if (!located.ok) {
    notes.push({ level: "fail", text: `app deck profile ${located.reason}` });
    return none("invalid");
  }
  const path = workLine.stable;
  if (!isDirectory(path)) {
    if (workLine.kind === "copy") {
      return none("not-yet", path);
    }
    notes.push({ level: "fail", text: `the work line ${path} is not a directory` });
    return none("invalid", path);
  }
  const head = gitHead(path);
  const appDir = join(path, located.root);
  const base = requestsOf(join(appDir, "ai-plugin.json"));
  const profileRoot = join(appDir, ".ai", "profiles", located.name);
  const own = requestsOf(join(profileRoot, "ai-plugin.json"));
  const promptText = readText(join(profileRoot, "prompt.md"))?.trim();
  const project: NonNullable<RoleReport["project"]> = {
    state: base === undefined && own === undefined ? "no-deck" : "read",
    profile,
    path,
    ...(head === undefined ? {} : head),
    ...(promptText === undefined || promptText.length === 0
      ? {}
      : { promptFile: join(profileRoot, "prompt.md"), promptText }),
  };
  const plugins: PluginReport[] = [];
  const baseLock = join(appDir, "ai-plugin.lock.json");
  const profileLock = join(profileRoot, "ai-plugin.lock.json");
  const unpinned = [
    ...unpinnedIn(base, baseLock).map((why) => ({ why, at: "the project" })),
    ...unpinnedIn(own, profileLock).map((why) => ({ why, at: `profile ${profile}` })),
  ];
  for (const { why, at } of unpinned) {
    notes.push({
      level: "fail",
      text: `${at}: ${why}. deck refuses it, so every attempt of this role fails until the project commits its locks`,
    });
  }
  if (base !== undefined && unpinnedIn(base, baseLock).length === 0) {
    plugins.push(...lockPlugins(baseLock, "base", notes));
  }
  if (own !== undefined && unpinnedIn(own, profileLock).length === 0) {
    plugins.push(...lockPlugins(profileLock, "profile", notes));
  }
  if (base !== undefined && own === undefined) {
    notes.push({
      level: "warn",
      text: `the project has no deck profile "${profile}": the base plugins only`,
    });
  }
  return { project, plugins };
}

function collisions(plugins: readonly PluginReport[], notes: Note[]): void {
  for (const kind of ["skills", "agents"] as const) {
    const owners = new Map<string, string[]>();
    for (const plugin of plugins) {
      for (const name of plugin[kind] ?? []) {
        owners.set(name, [...(owners.get(name) ?? []), plugin.id]);
      }
    }
    for (const [name, ids] of owners) {
      if (ids.length > 1) {
        notes.push({
          level: "warn",
          text: `the ${kind === "skills" ? "skill" : "agent"} "${name}" is in several plugins: ${ids.join(", ")}`,
        });
      }
    }
  }
}

function promptOf(role: string, file: string | undefined, notes: Note[]): string[] {
  if (file === undefined) {
    return [];
  }
  const text = readText(file);
  if (text === undefined) {
    notes.push({ level: "fail", text: `the prompt file ${file} cannot be read` });
    return [];
  }
  if (text.trim().length === 0) {
    notes.push({ level: "fail", text: `the prompt file ${file} is empty: the slot refuses it` });
    return [];
  }
  const found = [
    ...new Set([...text.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map((match) => match[1])),
  ].filter((name): name is string => name !== undefined);
  const table = PROMPT_PLACEHOLDERS[role];
  if (table !== undefined) {
    const unknown = found.filter((name) => !table.known.includes(name));
    if (unknown.length > 0) {
      notes.push({
        level: "fail",
        text: `the prompt uses {{${unknown.join("}}, {{")}}}, which this role does not fill (it fills: ${table.known.map((name) => `{{${name}}}`).join(" ")}); the slot refuses every attempt`,
      });
    }
    const missing = table.required.filter((name) => !found.includes(name));
    if (missing.length > 0) {
      notes.push({
        level: "fail",
        text: `the prompt does not place {{${missing.join("}}, {{")}}}, which this role requires; the slot refuses every attempt`,
      });
    }
  }
  return found;
}

function explainRole(
  def: RoleDef,
  workLine: WorkLineResolution,
  env: Record<string, string | undefined>,
): RoleReport {
  const notes: Note[] = [];
  const base = {
    role: def.role,
    timeoutMs: def.timeoutMs,
    ...(def.maxAttempts === undefined ? {} : { maxAttempts: def.maxAttempts }),
    gates: def.gates,
  };
  const split = def.cmd.indexOf("--");
  if (split === -1) {
    return { ...base, kind: "command", command: def.cmd, plugins: [], notes };
  }
  const own = def.cmd.slice(0, split);
  const agent = def.cmd.slice(split + 1);
  const script = agent.find((token) => token.endsWith(".mjs") || token.endsWith(".js"));
  const adapter = script === undefined ? "(unknown)" : basename(script).replace(/\.m?js$/, "");
  const promptFile = firstValue(own, "--prompt-file");
  const rulesFile = firstValue(own, "--rules-file");
  const placeholders = promptOf(def.role, promptFile, notes);
  const apiKeyEnv = firstValue(agent, "--api-key-env");
  const model = modelOf(agent);
  const agentHome = firstValue(agent, "--agent-home");

  const plugins: PluginReport[] = allValues(agent, "--plugin-dir").map((dir) =>
    homePlugin(dir, notes),
  );
  const profile = firstValue(agent, "--app-deck-profile");
  let project: RoleReport["project"];
  if (profile !== undefined) {
    const read = projectOf(profile, workLine, notes);
    project = read.project;
    plugins.push(...read.plugins);
  }
  collisions(plugins, notes);

  return {
    ...base,
    kind: "agent",
    agent: {
      adapter,
      ...(model === undefined ? {} : { model }),
      ...(agentHome === undefined ? {} : { home: agentHome }),
      ...(apiKeyEnv === undefined
        ? {}
        : { apiKeyEnv, apiKeySet: (env[apiKeyEnv] ?? "").trim().length > 0 }),
      denyShell: allValues(agent, "--deny-shell"),
    },
    prompt: {
      ...(promptFile === undefined ? {} : { file: promptFile }),
      placeholders,
      ...(rulesFile === undefined ? {} : { rulesFile }),
    },
    ...(project === undefined ? {} : { project }),
    plugins,
    notes,
  };
}

/**
 * Say what an agent role starts with, from the config and the files alone.
 *
 * Nothing runs and nothing is fetched. A deck plugin's contents come from the
 * lock the project committed; a fact that cannot be read says so instead of
 * being guessed, and a setup every attempt would fail on is a failure here too.
 */
export async function runExplain(input: ExplainInput): Promise<number> {
  const json = input.argv.includes("--json");
  const rest = input.argv.filter((token) => token !== "--json");
  const first = rest[0];
  const wanted = first !== undefined && !first.startsWith("-") ? first : undefined;
  const parsed = parseArgs(wanted === undefined ? rest : rest.slice(1), {
    cwd: input.cwd,
    checkPaths: false,
  });
  if (!parsed.ok) {
    input.write(`${parsed.reason}\n`);
    return 2;
  }
  const invocation = parsed.invocation;
  const defs = rolesOf(invocation);
  if (wanted !== undefined && !defs.some((def) => def.role === wanted)) {
    input.write(
      `No role "${wanted}" in this config. Roles: ${defs.map((def) => def.role).join(", ")}.\nUsage: ${CLI_NAME} explain [role] [--json]\n`,
    );
    return 2;
  }
  const loaded = await loadManagerModule(
    requestOf(invocation.ticketTracker, {
      configDir: invocation.configDir,
      durationMs: invocation.timeoutMs,
      interruptFlag: { interrupted: false },
      env: input.env,
    }),
  );
  const workLine = await workLineOf(invocation, loaded.ok ? loaded.module : undefined);
  const reports = defs
    .filter((def) => wanted === undefined || def.role === wanted)
    .map((def) => explainRole(def, workLine, input.env));

  if (json) {
    input.write(`${JSON.stringify({ roles: reports, notCovered: NOT_COVERED }, null, 2)}\n`);
  } else {
    input.write(renderReports(reports, invocation.configDir));
  }
  return reports.some((report) => report.notes.some((note) => note.level === "fail")) ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

const LABEL = 12;

function line(label: string, text: string): string {
  return `  ${label.padEnd(LABEL)}${text}`;
}

function more(text: string): string {
  return `  ${" ".repeat(LABEL)}${text}`;
}

function renderReports(reports: readonly RoleReport[], configDir: string): string {
  const rel = (path: string): string => {
    const inside = relative(configDir, path);
    return inside.length > 0 && !inside.startsWith("..") && !inside.startsWith("/")
      ? `./${inside}`
      : path;
  };
  const blocks = reports.map((report) => renderRole(report, rel));
  return `${blocks.join("\n\n")}\n\nNot shown here:\n${NOT_COVERED.map((item) => `  - ${item}`).join("\n")}\n`;
}

function list(label: string, items: readonly string[] | undefined): string {
  if (items === undefined) {
    return `${label}: not known`;
  }
  return items.length === 0 ? `${label}: none` : `${label}: ${items.join(", ")}`;
}

function renderRole(report: RoleReport, rel: (path: string) => string): string {
  const out: string[] = [report.role];
  if (report.kind === "command") {
    out.push(
      line("command", "this role runs a command, not an agent:"),
      more(report.command?.map(rel).join(" ") ?? ""),
    );
    return out.concat(renderNotes(report)).join("\n");
  }
  const agent = report.agent;
  const attempts = report.maxAttempts === undefined ? "" : `, up to ${report.maxAttempts} attempts`;
  out.push(
    line(
      "agent",
      `${agent?.adapter ?? "?"}, ${agent?.model === undefined ? "the vendor's default model" : `model ${agent.model}`}, ${Math.round(report.timeoutMs / 1000)}s${report.role === "authority.describe" ? " in all" : " per attempt"}${attempts}`,
    ),
  );
  const isolation = [
    agent?.home === undefined ? undefined : `HOME ${rel(agent.home)}`,
    agent?.apiKeyEnv === undefined
      ? undefined
      : `key from $${agent.apiKeyEnv} (${agent.apiKeySet === true ? "set" : "not set in this shell"})`,
    `refuses: ${[...(agent?.denyShell ?? []), "ssh", "scp"].join(", ")}`,
  ].filter((part): part is string => part !== undefined);
  out.push(line("isolation", isolation.join("; ")));

  const prompt = report.prompt;
  out.push(
    line(
      "prompt",
      `${prompt?.file === undefined ? "the slot's built-in template" : rel(prompt.file)}   [home]`,
    ),
  );
  if (prompt !== undefined && prompt.placeholders.length > 0) {
    out.push(more(`fills: ${prompt.placeholders.map((name) => `{{${name}}}`).join(" ")}`));
  }
  out.push(
    more(
      prompt?.rulesFile === undefined
        ? "{{rules}}: the slot's default list"
        : `{{rules}}: ${rel(prompt.rulesFile)}`,
    ),
  );
  const project = report.project;
  if (project?.promptText !== undefined && project.promptFile !== undefined) {
    const flat = project.promptText.replace(/\s+/g, " ");
    out.push(
      more(
        `then ${rel(project.promptFile)}   [project]: "${flat.length > 110 ? `${flat.slice(0, 109)}…` : flat}"`,
      ),
    );
  } else if (project !== undefined && project.state === "read") {
    out.push(more(`then nothing: profile ${project.profile} has no prompt`));
  }

  out.push(line("plugins", "in loading order"));
  for (const plugin of report.plugins) {
    out.push(
      `    ${`[${plugin.layer}]`.padEnd(10)}${plugin.id.padEnd(22)}${plugin.layer === "home" ? rel(plugin.source) : plugin.source}`,
    );
    if (plugin.note !== undefined) {
      out.push(`${" ".repeat(14)}${plugin.note}`);
      continue;
    }
    const parts = [list("skills", plugin.skills)];
    if (plugin.agents === undefined || plugin.agents.length > 0) {
      parts.push(list("agents", plugin.agents));
    }
    if (plugin.commands !== undefined && plugin.commands.length > 0) {
      parts.push(list("commands", plugin.commands));
    }
    if (plugin.hooks === true) {
      parts.push("hooks: yes, they run code");
    }
    if (plugin.mcp !== undefined && plugin.mcp.length > 0) {
      parts.push(`MCP servers: ${plugin.mcp.join(", ")}`);
    }
    for (const part of parts) {
      out.push(`${" ".repeat(14)}${part}`);
    }
  }
  if (report.plugins.length === 0) {
    out.push(`${" ".repeat(14)}none`);
  }

  if (project !== undefined) {
    out.push(line("project", projectSentence(project, rel)));
  }
  out.push(line("gates", report.gates.length === 0 ? "none" : report.gates.join(", ")));
  return out.concat(renderNotes(report)).join("\n");
}

function projectSentence(
  project: NonNullable<RoleReport["project"]>,
  rel: (path: string) => string,
): string {
  switch (project.state) {
    case "not-yet":
      return `not known yet: the work line ${project.path === undefined ? "" : rel(project.path)} does not exist before the first run`;
    case "invalid":
      return "not read: the work line is not usable";
    case "no-deck":
      return `${project.path === undefined ? "" : rel(project.path)}: no ai-plugin.json, so only the home's plugins load`;
    case "read": {
      const at =
        project.commit === undefined
          ? ""
          : ` at ${project.commit} (${project.date?.slice(0, 16).replace("T", " ") ?? "?"})`;
      return `${project.path === undefined ? "" : rel(project.path)}${at}, as last refreshed; a ticket is built from the line as it is then`;
    }
  }
}

function renderNotes(report: RoleReport): string[] {
  return report.notes.map((note) => line(note.level === "fail" ? "FAIL" : "warn", note.text));
}
