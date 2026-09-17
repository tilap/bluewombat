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

const transcript = transcriptFor(process.argv, options, {
  slot: NAME,
  bin,
  args,
  prompt,
});
const run = await runAgent({ file: bin, args, cwd });
const extras = extrasFromCursor(run.stdout, outputFormat);
transcript.write(run, extras);
answer(run, bin, extras);

/** @param {string} reason @returns {never} */
function refuse(reason) {
  process.stdout.write(`${JSON.stringify({ error: reason })}\n`);
  process.exit(1);
}

/**
 * @param {import("@bluewombat/slot-kit").AgentRun} run
 * @param {string} binPath
 * @param {import("@bluewombat/slot-kit").AgentExtras} extras
 * @returns {never}
 */
function answer(run, binPath, extras) {
  process.stdout.write(
    `${JSON.stringify(
      serializeRun(run, { name: NAME, bin: binPath, skills: extras.skills, usage: extras.usage }),
    )}\n`,
  );
  process.exit(0);
}
