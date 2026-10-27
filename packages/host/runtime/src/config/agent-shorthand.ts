import { isAbsolute, resolve } from "node:path";

/**
 * The short way to write an agent pass: which agent, which prompt, which
 * plugins — and Host writes the argv a pass has always been.
 *
 *   agents:
 *     cursor: { adapter: cursor, home: ./.mason/agent-home, apiKeyEnv: CURSOR_API_KEY,
 *               transcripts: ./.mason/transcripts, pluginsOut: ./.mason/plugins }
 *   builder:
 *     producer: { agent: cursor, prompt: ./prompts/builder.md,
 *                 homePlugins: [./ai-plugins/core/builder],
 *                 appDeckProfile: .ai/profiles/builder, timeoutMs: … }
 *
 * expands to
 *
 *   node <slots>/builders/producer.mjs --prompt-file <prompt> --
 *     node <slots>/agents/cursor.mjs --transcript-dir … --agent-home … --api-key-env …
 *       --plugin-dir <core> --app-deck-profile .ai/profiles/builder --plugins-out …
 *
 * The expansion is the whole ticket: nothing downstream knows a pass was
 * written short, so `cmd` stays the one shape the rest of Host reads, and a
 * pass that needs something the short form cannot say still writes `cmd`.
 */

/** Where the shipped slots live, next to the config: what `npm install` in a Mason home makes. */
const SLOTS_PACKAGE = "node_modules/@bluewombat/slots";

/** The shipped role slot behind each pass that drives an agent. */
export const ROLE_SCRIPTS = {
  "builder.producer": "builders/producer.mjs",
  "builder.repair": "builders/repair.mjs",
  "builder.featureTest": "builders/feature-test.mjs",
  "ticket.fix": "ticket/fix.mjs",
  "ticket.validate": "ticket/validate.mjs",
  "feature.fix": "feature/fix.mjs",
  "feature.validate": "feature/validate.mjs",
  "authority.describe": "messages/git-producer.mjs",
} as const;

export type AgentRole = keyof typeof ROLE_SCRIPTS;

const ADAPTERS = new Set(["cursor", "claude"]);
const AGENT_KEYS = new Set([
  "adapter",
  "bin",
  "model",
  "home",
  "apiKeyEnv",
  "passEnv",
  "denyShell",
  "transcripts",
  "pluginsOut",
  "args",
]);

/** The keys a pass written short may carry, besides its own (`timeoutMs`, `gates`). */
export const SHORT_PASS_KEYS = new Set([
  "agent",
  "prompt",
  "rules",
  "homePlugins",
  "appDeckProfile",
  "args",
]);

/** One agent as `agents.<name>` declares it, paths already resolved. */
export type AgentDecl = {
  adapter: string;
  bin?: string;
  model?: string;
  home?: string;
  apiKeyEnv?: string;
  passEnv: string[];
  denyShell: string[];
  transcripts?: string;
  pluginsOut?: string;
  args: string[];
};

export type Agents = ReadonlyMap<string, AgentDecl>;

type Read<T> = { ok: true; value: T } | { ok: false; reason: string };

export function readAgents(value: unknown, configDir: string): Read<Map<string, AgentDecl>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: 'Config "agents" must be a YAML mapping of agent names.' };
  }
  const agents = new Map<string, AgentDecl>();
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    const key = `agents.${name}`;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, reason: `Config "${key}" must be a YAML mapping.` };
    }
    const object = raw as Record<string, unknown>;
    for (const field of Object.keys(object)) {
      if (!AGENT_KEYS.has(field)) {
        return { ok: false, reason: `Config "${key}" has unknown key "${field}".` };
      }
    }
    const fields: Record<string, string | undefined> = {};
    for (const field of [
      "adapter",
      "bin",
      "model",
      "home",
      "apiKeyEnv",
      "transcripts",
      "pluginsOut",
    ]) {
      const text = object[field];
      if (text !== undefined && (typeof text !== "string" || text.trim().length === 0)) {
        return { ok: false, reason: `Config "${key}.${field}" must be a non-empty string.` };
      }
      fields[field] = text as string | undefined;
    }
    const adapter = fields.adapter;
    if (adapter === undefined) {
      return {
        ok: false,
        reason: `Config "${key}" needs an "adapter": cursor, claude, or the path of an agent wrapper.`,
      };
    }
    if ((fields.home === undefined) !== (fields.apiKeyEnv === undefined)) {
      return {
        ok: false,
        reason: `Config "${key}" isolates an agent with "home" and "apiKeyEnv" together, or neither.`,
      };
    }
    const args = stringList(object.args, `${key}.args`);
    if (args.ok === false) {
      return args;
    }
    const passEnv = stringList(object.passEnv, `${key}.passEnv`);
    if (passEnv.ok === false) {
      return passEnv;
    }
    const denyShell = stringList(object.denyShell, `${key}.denyShell`);
    if (denyShell.ok === false) {
      return denyShell;
    }
    for (const [field, list] of [
      ["passEnv", passEnv.value],
      ["denyShell", denyShell.value],
    ] as const) {
      if (list.length > 0 && fields.home === undefined) {
        return {
          ok: false,
          reason: `Config "${key}.${field}" only applies to an isolated agent: set "home" and "apiKeyEnv".`,
        };
      }
    }
    const at = (path: string | undefined) =>
      path === undefined ? undefined : resolve(configDir, path);
    const decl: AgentDecl = {
      adapter: ADAPTERS.has(adapter)
        ? resolve(configDir, SLOTS_PACKAGE, "agents", `${adapter}.mjs`)
        : resolve(configDir, adapter),
      passEnv: passEnv.value,
      denyShell: denyShell.value,
      args: args.value,
    };
    // A binary named bare is looked up on PATH; one written as a path is next to the config.
    const bin = fields.bin;
    if (bin !== undefined) {
      decl.bin = bin.includes("/") ? resolve(configDir, bin) : bin;
    }
    if (fields.model !== undefined) {
      decl.model = fields.model;
    }
    const home = at(fields.home);
    if (home !== undefined) {
      decl.home = home;
    }
    if (fields.apiKeyEnv !== undefined) {
      decl.apiKeyEnv = fields.apiKeyEnv;
    }
    const transcripts = at(fields.transcripts);
    if (transcripts !== undefined) {
      decl.transcripts = transcripts;
    }
    const pluginsOut = at(fields.pluginsOut);
    if (pluginsOut !== undefined) {
      decl.pluginsOut = pluginsOut;
    }
    agents.set(name, decl);
  }
  return { ok: true, value: agents };
}

/**
 * The argv a pass written short stands for. `object` is the pass's own
 * mapping; its keys were checked by the caller.
 */
export function expandAgentPass(
  object: Record<string, unknown>,
  role: AgentRole,
  agents: Agents,
  configDir: string,
  key: string,
): Read<string[]> {
  if (object.cmd !== undefined) {
    return { ok: false, reason: `Config "${key}" names "cmd" and "agent": write one of the two.` };
  }
  const name = object.agent;
  if (typeof name !== "string" || name.trim().length === 0) {
    return { ok: false, reason: `Config "${key}.agent" must name an agent of "agents".` };
  }
  const agent = agents.get(name);
  if (agent === undefined) {
    return {
      ok: false,
      reason: `Config "${key}.agent" is "${name}", and "agents" declares no such agent.`,
    };
  }
  const prompt = pathField(object, "prompt", key, configDir);
  if (prompt.ok === false) {
    return prompt;
  }
  const rules = pathField(object, "rules", key, configDir);
  if (rules.ok === false) {
    return rules;
  }
  const plugins = stringList(object.homePlugins, `${key}.homePlugins`);
  if (plugins.ok === false) {
    return plugins;
  }
  const profile = object.appDeckProfile;
  if (profile !== undefined) {
    if (typeof profile !== "string") {
      return { ok: false, reason: `Config "${key}.appDeckProfile" must be a path.` };
    }
    const located = parseAppDeckProfile(profile);
    if (!located.ok) {
      return { ok: false, reason: `Config "${key}.appDeckProfile": ${located.reason}` };
    }
    if (agent.pluginsOut === undefined) {
      return {
        ok: false,
        reason: `Config "${key}" names an app deck profile, so "agents.${name}.pluginsOut" must say where it is built.`,
      };
    }
  }
  const args = stringList(object.args, `${key}.args`);
  if (args.ok === false) {
    return args;
  }

  const argv = ["node", resolve(configDir, SLOTS_PACKAGE, ROLE_SCRIPTS[role])];
  if (prompt.value !== undefined) {
    argv.push("--prompt-file", prompt.value);
  }
  if (rules.value !== undefined) {
    argv.push("--rules-file", rules.value);
  }
  argv.push("--", "node", agent.adapter);
  if (agent.bin !== undefined) {
    argv.push("--bin", agent.bin);
  }
  if (agent.model !== undefined) {
    argv.push("--model", agent.model);
  }
  if (agent.transcripts !== undefined) {
    argv.push("--transcript-dir", agent.transcripts);
  }
  if (agent.home !== undefined && agent.apiKeyEnv !== undefined) {
    argv.push("--agent-home", agent.home, "--api-key-env", agent.apiKeyEnv);
    for (const name of agent.passEnv) {
      argv.push("--pass-env", name);
    }
    for (const name of agent.denyShell) {
      argv.push("--deny-shell", name);
    }
  }
  for (const dir of plugins.value) {
    argv.push("--plugin-dir", resolve(configDir, dir));
  }
  if (profile !== undefined && agent.pluginsOut !== undefined) {
    argv.push("--app-deck-profile", profile as string, "--plugins-out", agent.pluginsOut);
  }
  for (const arg of [...agent.args, ...args.value]) {
    argv.push("--agent-arg", arg);
  }
  return { ok: true, value: argv };
}

/**
 * Where an app's deck profile is, from the path the config gives it: the app
 * folder that holds `.ai/` (`.` for the checkout itself) and the profile's name.
 * deck keeps its profiles in `<app>/.ai/profiles/<name>`, so that is the shape;
 * the app folder is what a Project may place elsewhere in its checkout.
 *
 * The slot that builds the profile reads the path by the same rule
 * (`parseAppDeckProfile` in `agent-plugins.mjs`); neither depends on the other.
 */
export function parseAppDeckProfile(
  given: string,
): { ok: true; root: string; name: string } | { ok: false; reason: string } {
  const matched = /^(?:(.*?)\/)?\.ai\/profiles\/([^/]+)\/?$/.exec(given.trim());
  const name = matched?.[2];
  if (
    matched === null ||
    name === undefined ||
    !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(name) ||
    name === "current"
  ) {
    return {
      ok: false,
      reason: `"${given}" is not a deck profile path: [<app dir>/].ai/profiles/<name>.`,
    };
  }
  const root = matched[1] ?? ".";
  if (isAbsolute(root) || root.split("/").includes("..")) {
    return { ok: false, reason: `"${given}" must stay inside the checkout.` };
  }
  return { ok: true, root, name };
}

/** The agent and profile a pass's argv names, written short or not; for `doctor`. */
export function agentPartOf(argv: readonly string[]): {
  appDeckProfile?: string;
  pluginsOut?: string;
  pluginDirs: string[];
} {
  const split = argv.indexOf("--");
  const agent = split === -1 ? [] : argv.slice(split + 1);
  const found: { appDeckProfile?: string; pluginsOut?: string; pluginDirs: string[] } = {
    pluginDirs: [],
  };
  agent.forEach((token, at) => {
    const value = agent[at + 1];
    if (value === undefined) {
      return;
    }
    if (token === "--app-deck-profile") {
      found.appDeckProfile = value;
    } else if (token === "--plugins-out") {
      found.pluginsOut = value;
    } else if (token === "--plugin-dir") {
      found.pluginDirs.push(value);
    }
  });
  return found;
}

function pathField(
  object: Record<string, unknown>,
  field: string,
  key: string,
  configDir: string,
): Read<string | undefined> {
  const value = object[field];
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return { ok: false, reason: `Config "${key}.${field}" must be a non-empty path.` };
  }
  return { ok: true, value: resolve(configDir, value) };
}

function stringList(value: unknown, key: string): Read<string[]> {
  if (value === undefined) {
    return { ok: true, value: [] };
  }
  if (!Array.isArray(value) || value.some((token) => typeof token !== "string")) {
    return { ok: false, reason: `Config "${key}" must be an array of strings.` };
  }
  return { ok: true, value: value as string[] };
}
