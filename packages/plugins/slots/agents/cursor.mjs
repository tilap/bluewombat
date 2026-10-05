#!/usr/bin/env node
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
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
//   --id / --attempt / --context   how a transcript is filed

const NAME = "Cursor CLI";
const CLI_NAMES = ["cursor-agent", "agent"];
const INSTALL_DIRS = [join(homedir(), ".local/bin"), join(homedir(), ".cursor/bin")];

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
const prompt = loaded.prompt;

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
  return { ok: true, env: isolatedVendorEnv(resolve(dir, home), apiKey) };
}

/**
 * @param {string} agentHome
 * @param {string} apiKey
 * @returns {NodeJS.ProcessEnv}
 */
function isolatedVendorEnv(agentHome, apiKey) {
  mkdirSync(agentHome, { recursive: true });
  const parentHome = homedir();
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, HOME: agentHome };
  if (process.env.PATH !== undefined) {
    env.PATH = process.env.PATH;
  }
  env.CURSOR_API_KEY = apiKey;
  env.AGENT_CLI_CREDENTIAL_STORE = "memory";
  const gitConfig = parentGitConfig(parentHome);
  if (gitConfig === undefined) {
    delete env.GIT_CONFIG_GLOBAL;
  } else {
    env.GIT_CONFIG_GLOBAL = gitConfig;
  }
  const npmCache = process.env.npm_config_cache;
  env.npm_config_cache =
    npmCache !== undefined && npmCache.length > 0 ? npmCache : join(parentHome, ".npm");
  const corepack = parentCorepack(parentHome);
  if (corepack === undefined) {
    delete env.COREPACK_HOME;
  } else {
    env.COREPACK_HOME = corepack;
  }
  return env;
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
      }),
    )}\n`,
  );
  process.exit(0);
}
