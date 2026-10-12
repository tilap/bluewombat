#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  AGENT_OPTIONS,
  findExecutable,
  listOption,
  parseOptions,
  readAgentPrompt,
  runAgent,
  serializeRun,
  textOption,
  transcriptFor,
  writeContract,
} from "@bluewombat/slot-kit";
import { loadPlugins, pluginDirArgs, withProfilePrompt } from "./agent-plugins.mjs";
import { extrasFromCursor } from "./cursor-extras.mjs";

// Cursor CLI as a vendor agent. The prompt is already filled: this command
// does not interpolate. Own options only — a role slot strips Implementer's
// flags before spawning this.
//   --prompt TEXT / --prompt-file PATH   the filled prompt. One of the two
//   --bin PATH            the Cursor CLI. Default: cursor-agent, found
//   --model NAME
//   --output-format FMT   stream-json (default), json, or text
//   --transcript-dir PATH write one file per turn. Off by default
//   --transcript-part NAME prompt, stdout, stderr, timing. Repeatable
//   --agent-arg VALUE     appended before the prompt. Repeatable
//   --agent-home DIR      isolate this process: HOME is DIR, not the operator's
//   --api-key-env NAME    required with --agent-home. Read process.env[NAME];
//                         the value is never put on the argv
//   --pass-env NAME       with --agent-home: also hand the vendor this variable
//                         of the operator. Repeatable. The vendor otherwise
//                         gets a short list (KEPT_ENV), not the whole environment
//   --deny-shell NAME     with --agent-home: also refuse this command to the
//                         vendor (`gh`, `vercel`…). Repeatable. ssh and scp are
//                         always refused
//   --plugin-dir / --profile / --plugins-out / --deck-bin   plugin folders,
//                         see agent-plugins.mjs
//   --id / --attempt / --context   how a transcript is filed

const NAME = "Cursor CLI";
const CLI_NAMES = ["cursor-agent", "agent"];
const INSTALL_DIRS = [join(homedir(), ".local/bin"), join(homedir(), ".cursor/bin")];

/**
 * What the vendor gets of the operator's environment, besides what this file
 * sets itself: enough to find tools, name the locale and reach the network.
 * Tokens, agent sockets and the rest of an interactive shell stay with the
 * operator; a Project that needs one more names it with `--pass-env`.
 */
const KEPT_ENV = [
  "PATH",
  "TERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "USER",
  "LOGNAME",
  "SHELL",
  "PNPM_HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
];

/**
 * Commands refused to the vendor whatever the Project says: the ones that
 * reach for the operator's own logins through a socket or a key. A Project adds
 * its own with `--deny-shell` (the GitHub CLI reads a keychain whatever HOME
 * is; `security` is macOS only; each machine has its own). The vendor's
 * permission list refuses a command even under `--force`. It is a list of
 * names, not a sandbox: `python -c` goes round it.
 */
const DENIED_SHELL = ["ssh", "scp"];

const cwd = process.cwd();

const parsed = parseOptions(process.argv.slice(2), AGENT_OPTIONS, NAME);
if (!parsed.ok) {
  refuse(parsed.reason);
}
const options = parsed.values;

const loaded = readAgentPrompt(options);
if (!loaded.ok) {
  refuse(loaded.reason);
}
const loadedPlugins = loadPlugins(options, cwd);
if (!loadedPlugins.ok) {
  refuse(loadedPlugins.reason);
}
for (const note of loadedPlugins.notes) {
  process.stderr.write(`${note}\n`);
}
const plugins = loadedPlugins.plugins;
const prompt = withProfilePrompt(loaded.prompt, loadedPlugins.prompt);

const bin = textOption(options, "bin") ?? findExecutable(CLI_NAMES, INSTALL_DIRS);
if (bin === undefined) {
  refuse(
    "Cursor CLI `cursor-agent` is not on PATH. Install it and run `cursor-agent login`, or pass --bin.",
  );
}

const model = textOption(options, "model");
/** @type {string} */
const outputFormat = /** @type {string} */ (options.outputFormat);
const args = [
  "-p",
  "--force",
  "--trust",
  "--workspace",
  cwd,
  "--sandbox",
  "disabled",
  "--output-format",
  outputFormat,
  ...(model === undefined ? [] : ["--model", model]),
  ...pluginDirArgs(plugins),
  ...listOption(options, "agentArg"),
  prompt,
];

const isolation = cursorIsolation(options, cwd);
if (!isolation.ok) {
  refuse(isolation.reason);
}

const transcript = transcriptFor(process.argv, options, {
  slot: NAME,
  bin,
  args,
  prompt,
  plugins,
});
const run = await runAgent({
  file: bin,
  args,
  cwd,
  ...(isolation.env === undefined ? {} : { env: isolation.env }),
});
const extras = extrasFromCursor(run.stdout, outputFormat, cwd);
transcript.write(run, extras);
answer(run, bin, extras);

/**
 * `--agent-home` isolates the vendor process. The wrapper keeps the parent's
 * HOME, so `findExecutable` still sees the operator's install directories.
 * No link to the login keychain: auth is the named variable, held in memory.
 *
 * @param {import("@bluewombat/slot-kit").OptionValues} options
 * @param {string} dir
 * @returns {{ ok: true, env: NodeJS.ProcessEnv | undefined } | { ok: false, reason: string }}
 */
function cursorIsolation(options, dir) {
  const home = textOption(options, "agentHome");
  const keyEnv = textOption(options, "apiKeyEnv");
  if (home === undefined && keyEnv === undefined) {
    return { ok: true, env: undefined };
  }
  if (home === undefined || keyEnv === undefined) {
    return {
      ok: false,
      reason: "An isolated Cursor agent needs both --agent-home and --api-key-env.",
    };
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyEnv)) {
    return {
      ok: false,
      reason: `--api-key-env must name an environment variable, not "${keyEnv}".`,
    };
  }
  const apiKey = process.env[keyEnv];
  if (apiKey === undefined || apiKey.length === 0) {
    return {
      ok: false,
      reason: `The environment variable ${keyEnv} is empty. An isolated Cursor agent needs it, or the CLI tries to store credentials in the login keychain.`,
    };
  }
  const passEnv = listOption(options, "passEnv");
  const bad = passEnv.find((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
  if (bad !== undefined) {
    return { ok: false, reason: `--pass-env must name an environment variable, not "${bad}".` };
  }
  const denyShell = listOption(options, "denyShell");
  const badCommand = denyShell.find((name) => !/^[A-Za-z0-9._+-]+$/.test(name));
  if (badCommand !== undefined) {
    return {
      ok: false,
      reason: `--deny-shell must name a command, not "${badCommand}".`,
    };
  }
  const agentHome = resolve(dir, home);
  const env = isolatedVendorEnv(agentHome, apiKey, passEnv);
  denyShellCommands(agentHome, denyShell);
  return { ok: true, env };
}

/**
 * @param {string} agentHome
 * @param {string} apiKey
 * @param {readonly string[]} passEnv
 * @returns {NodeJS.ProcessEnv}
 */
function isolatedVendorEnv(agentHome, apiKey, passEnv) {
  mkdirSync(agentHome, { recursive: true });
  const parentHome = homedir();
  /** @type {NodeJS.ProcessEnv} */
  const env = { HOME: agentHome };
  for (const name of [...KEPT_ENV, ...passEnv]) {
    if (process.env[name] !== undefined) {
      env[name] = process.env[name];
    }
  }
  env.CURSOR_API_KEY = apiKey;
  env.AGENT_CLI_CREDENTIAL_STORE = "memory";
  // The operator's git config may name a credential helper (a keychain with
  // their account). An empty helper first clears that list for the vendor's
  // git, and a missing credential fails instead of prompting.
  env.GIT_CONFIG_COUNT = "1";
  env.GIT_CONFIG_KEY_0 = "credential.helper";
  env.GIT_CONFIG_VALUE_0 = "";
  env.GIT_TERMINAL_PROMPT = "0";
  const gitConfig = parentGitConfig(parentHome);
  if (gitConfig !== undefined) {
    env.GIT_CONFIG_GLOBAL = gitConfig;
  }
  const npmCache = process.env.npm_config_cache;
  env.npm_config_cache =
    npmCache !== undefined && npmCache.length > 0 ? npmCache : join(parentHome, ".npm");
  const corepack = parentCorepack(parentHome);
  if (corepack !== undefined) {
    env.COREPACK_HOME = corepack;
  }
  return env;
}

/**
 * Write the denials into the vendor's own config in `agentHome`, keeping what
 * else is in it. Every pass, because the vendor can edit that file.
 *
 * @param {string} agentHome
 * @param {readonly string[]} extra  commands the Project also refuses
 */
function denyShellCommands(agentHome, extra) {
  const file = join(agentHome, ".cursor", "cli-config.json");
  /** @type {Record<string, any>} */
  let config = {};
  try {
    config = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // none yet, or unreadable: start from nothing rather than refuse to run
  }
  const permissions = config.permissions ?? {};
  const deny = Array.isArray(permissions.deny) ? permissions.deny : [];
  config.permissions = {
    ...permissions,
    allow: Array.isArray(permissions.allow) ? permissions.allow : [],
    deny: [...new Set([...deny, ...[...DENIED_SHELL, ...extra].map((name) => `Shell(${name})`)])],
  };
  mkdirSync(dirname(file), { recursive: true });
  const next = `${file}.${process.pid}.tmp`;
  writeFileSync(next, `${JSON.stringify(config, null, 2)}\n`);
  renameSync(next, file);
}

/**
 * The global git file the parent already resolves. `~/.gitconfig` wins over
 * the XDG file, which is git's own order when both exist.
 *
 * @param {string} parentHome
 * @returns {string | undefined}
 */
function parentGitConfig(parentHome) {
  const fromEnv = process.env.GIT_CONFIG_GLOBAL;
  if (fromEnv !== undefined && fromEnv.length > 0 && existsSync(fromEnv)) {
    return fromEnv;
  }
  const dot = join(parentHome, ".gitconfig");
  if (existsSync(dot)) {
    return dot;
  }
  const xdgRoot = process.env.XDG_CONFIG_HOME;
  const xdg = join(
    xdgRoot !== undefined && xdgRoot.length > 0 ? xdgRoot : join(parentHome, ".config"),
    "git",
    "config",
  );
  return existsSync(xdg) ? xdg : undefined;
}

/**
 * @param {string} parentHome
 * @returns {string | undefined}
 */
function parentCorepack(parentHome) {
  const fromEnv = process.env.COREPACK_HOME;
  if (fromEnv !== undefined && fromEnv.length > 0 && existsSync(fromEnv)) {
    return fromEnv;
  }
  const fallback = join(parentHome, ".cache", "node", "corepack");
  return existsSync(fallback) ? fallback : undefined;
}

/** @param {string} reason @returns {never} */
function refuse(reason) {
  writeContract(`${JSON.stringify({ error: reason })}\n`);
  process.exit(1);
}

/**
 * @param {import("@bluewombat/slot-kit").AgentRun} run
 * @param {string} binPath
 * @param {import("@bluewombat/slot-kit").AgentExtras} extras
 * @returns {never}
 */
function answer(run, binPath, extras) {
  writeContract(
    `${JSON.stringify(
      serializeRun(run, {
        name: NAME,
        bin: binPath,
        skills: extras.skills,
        usage: extras.usage,
        tools: extras.tools,
        plugins,
      }),
    )}\n`,
  );
  process.exit(0);
}
