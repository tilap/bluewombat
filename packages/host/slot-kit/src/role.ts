import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentRun, deserializeRun, readResult } from "./agent.js";
import { ownArgv, splitRunner, take } from "./argv.js";
import { type OptionSpec, type OptionValues, parseOptions, textOption } from "./options.js";
import { type ReadTemplate, type Rendered, readTemplate, renderPrompt } from "./prompt.js";

/**
 * The role side of the role → agent split. A role slot fills a template and
 * hands the rendered prompt to the agent command after `--`; the agent side
 * (`AGENT_OPTIONS`, `readAgentPrompt`, `serializeRun`) is in `prompt.ts` and
 * `agent.ts`. Both halves in one kit so a role written elsewhere can talk to a
 * shipped agent, and the other way round.
 */

/** The flags every role takes: its template, and the rules it fills in. */
export const ROLE_OPTIONS: OptionSpec = {
  "--prompt-file": {},
  "--rules-file": {},
};

export type ParsedRole =
  | { ok: true; options: OptionValues; runner: string[] }
  | { ok: false; reason: string };

/**
 * This slot's flags, and the agent command after `--`.
 *
 * Implementer / Breakdown flags are stripped first so `--intention` never
 * lands in the agent argv: that command takes a filled prompt, not a Task.
 */
export function parseRole(
  argv: readonly string[],
  callerFlags: ReadonlySet<string>,
  name: string,
  extraSpec: OptionSpec = {},
): ParsedRole {
  const tokens = ownArgv(argv, callerFlags);
  const split = splitRunner(tokens);
  if (!split.ok) {
    return { ok: false, reason: `The ${name} needs an agent command after --.` };
  }
  const parsed = parseOptions(split.own, { ...ROLE_OPTIONS, ...extraSpec }, name);
  if (!parsed.ok) {
    return parsed;
  }
  return { ok: true, options: parsed.values, runner: split.runner };
}

/** The `--prompt-file` template, or the role's built-in one. */
export function loadPrompt(options: OptionValues, fallback: string): ReadTemplate {
  return readTemplate(textOption(options, "promptFile"), fallback);
}

/** The `--rules-file` text, or the role's built-in rules. */
export function loadRules(options: OptionValues, fallback: string): ReadTemplate {
  return readTemplate(textOption(options, "rulesFile"), fallback, "rules file");
}

/** `renderPrompt`, with the template's origin in the refusal so a typo is findable. */
export function fillPrompt(
  template: string,
  values: Record<string, string>,
  required: readonly string[],
  source: string,
): Rendered {
  const rendered = renderPrompt(template, values, required);
  if (!rendered.ok) {
    return { ok: false, reason: `${rendered.reason} (${source})` };
  }
  return rendered;
}

export type TranscriptExtras = {
  id?: string | undefined;
  attempt?: string | undefined;
  context?: string | undefined;
};

/** `--id`, `--attempt`, `--context` the agent CLI files a transcript under. */
export function transcriptArgs(argv: readonly string[], extras: TranscriptExtras = {}): string[] {
  const out: string[] = [];
  const id = extras.id ?? take(argv, "--id");
  const attempt = extras.attempt ?? take(argv, "--attempt");
  const context = extras.context ?? take(argv, "--context");
  if (id !== undefined) {
    out.push("--id", id);
  }
  if (attempt !== undefined) {
    out.push("--attempt", attempt);
  }
  if (context !== undefined) {
    out.push("--context", context);
  }
  return out;
}

export type AgentAbout = { name: string; bin: string };

export type SpawnedAgent =
  | { ok: true; run: AgentRun; about: AgentAbout }
  | { ok: false; reason: string };

/**
 * Spawn the agent command with the filled prompt as `--prompt-file`.
 *
 * The prompt goes in a file rather than argv so a long template cannot hit
 * ARG_MAX. The agent's stdout is the serialized run; its stderr is inherited
 * so the vendor's stream still reaches the operator.
 */
export async function spawnFilled(
  runner: readonly string[],
  prompt: string,
  extraArgs: readonly string[] = [],
  cwd: string = process.cwd(),
): Promise<SpawnedAgent> {
  const dir = mkdtempSync(join(tmpdir(), "prompt-"));
  const promptFile = join(dir, "prompt.md");
  writeFileSync(promptFile, prompt);
  try {
    const [file, ...args] = runner;
    if (file === undefined) {
      return { ok: false, reason: "The agent command is empty." };
    }
    const stdout = await collectStdout(
      file,
      [...args, "--prompt-file", promptFile, ...extraArgs],
      cwd,
    );
    if (!stdout.ok) {
      return stdout;
    }
    const payload = readResult(stdout.value);
    if (payload === undefined) {
      return { ok: false, reason: "The agent command wrote no result." };
    }
    const run = deserializeRun(payload);
    if (run === undefined) {
      return {
        ok: false,
        reason:
          typeof payload.error === "string" ? payload.error : "The agent command wrote no result.",
      };
    }
    return { ok: true, run, about: aboutOf(payload) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function aboutOf(payload: Record<string, unknown>): AgentAbout {
  return {
    name: typeof payload.name === "string" ? payload.name : "agent",
    bin: typeof payload.bin === "string" ? payload.bin : "agent",
  };
}

function collectStdout(
  file: string,
  args: readonly string[],
  cwd: string,
): Promise<{ ok: true; value: string } | { ok: false; reason: string }> {
  return new Promise((resolve) => {
    // process-tree:layer — see agent.ts: no group of its own.
    const child = spawn(file, [...args], { cwd, stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", (error) => {
      resolve({
        ok: false,
        reason: `Could not start the agent command at ${file}: ${error.message}`,
      });
    });
    child.on("exit", () => {
      resolve({ ok: true, value: stdout });
    });
  });
}
