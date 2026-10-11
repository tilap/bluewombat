#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
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
import { loadPlugins, pluginDirArgs } from "./agent-plugins.mjs";
import { extrasFromClaude } from "./claude-extras.mjs";

// Claude Code as a vendor agent. The prompt is already filled: this command
// does not interpolate. Own options only — a role slot strips Implementer's
// flags before spawning this.
//   --prompt TEXT / --prompt-file PATH   the filled prompt. One of the two
//   --bin PATH             the Claude CLI. Default: claude, found on PATH
//   --model NAME           alias (opus, sonnet) or full name
//   --output-format FMT    stream-json (default), json, or text
//   --permission-mode MODE bypassPermissions (default), acceptEdits, …
//   --transcript-dir PATH  write one file per turn. Off by default
//   --transcript-part NAME prompt, stdout, stderr, timing. Repeatable
//   --agent-arg VALUE      appended before the prompt. Repeatable
//   --agent-home / --api-key-env   recognised, then refused. Claude is not
//                         isolated yet; starting would keep the operator's config
//   --plugin-dir DIR      a plugin folder, repeatable (see agent-plugins.mjs)
//   --profile / --plugins-out / --deck-bin   recognised, then refused for the
//                         same reason: Claude would also load the operator's
//                         and the project's own plugins, so a role's profile
//                         would not be what it gets
//   --id / --attempt / --context   how a transcript is filed

const NAME = "Claude Code";
const CLI_NAMES = ["claude"];
const INSTALL_DIRS = [join(homedir(), ".local/bin"), join(homedir(), ".claude/bin")];
const OPTIONS = {
  ...AGENT_OPTIONS,
  "--permission-mode": {
    choices: ["bypassPermissions", "acceptEdits", "auto", "dontAsk", "manual", "plan"],
    fallback: "bypassPermissions",
  },
};

const cwd = process.cwd();

const parsed = parseOptions(process.argv.slice(2), OPTIONS, NAME);
if (!parsed.ok) {
  refuse(parsed.reason);
}
const options = parsed.values;

if (
  textOption(options, "agentHome") !== undefined ||
  textOption(options, "apiKeyEnv") !== undefined
) {
  refuse(
    "Claude Code does not isolate the operator home yet. Remove --agent-home and --api-key-env; the vendor was not started.",
  );
}
if (
  textOption(options, "profile") !== undefined ||
  textOption(options, "pluginsOut") !== undefined ||
  textOption(options, "deckBin") !== undefined
) {
  refuse(
    "Claude Code does not isolate the operator home yet, so a deck profile would not be all it loads. Remove --profile; the vendor was not started.",
  );
}

const loaded = readAgentPrompt(options);
if (!loaded.ok) {
  refuse(loaded.reason);
}
const prompt = loaded.prompt;

const loadedPlugins = loadPlugins(options, cwd);
if (!loadedPlugins.ok) {
  refuse(loadedPlugins.reason);
}
const plugins = loadedPlugins.plugins;

const bin = textOption(options, "bin") ?? findExecutable(CLI_NAMES, INSTALL_DIRS);
if (bin === undefined) {
  refuse(
    "Claude Code `claude` is not on PATH. Install it and run `claude` once to sign in, or pass --bin. A global npm install belongs to one Node version: after `nvm use`, give --bin the absolute path.",
  );
}

const model = textOption(options, "model");
/** @type {string} */
const outputFormat = /** @type {string} */ (options.outputFormat);
const args = [
  "-p",
  "--permission-mode",
  /** @type {string} */ (options.permissionMode),
  "--output-format",
  outputFormat,
  // Claude's stream-json only emits tool events with --verbose (headless docs).
  ...(outputFormat === "stream-json" ? ["--verbose"] : []),
  ...(model === undefined ? [] : ["--model", model]),
  ...pluginDirArgs(plugins),
  ...listOption(options, "agentArg"),
  prompt,
];

const transcript = transcriptFor(process.argv, options, {
  slot: NAME,
  bin,
  args,
  prompt,
  plugins,
});
const run = await runAgent({ file: bin, args, cwd });
const extras = extrasFromClaude(run.stdout, outputFormat, cwd);
transcript.write(run, extras);
answer(run, bin, extras);

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
