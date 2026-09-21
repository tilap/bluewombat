import { readFileSync } from "node:fs";
import { take } from "./argv.js";
import { type OptionSpec, type OptionValues, textOption } from "./options.js";
import { openTranscript, TRANSCRIPT_PARTS, type Transcript } from "./transcript.js";

/**
 * The bounds of a Builder slot: what `{{rules}}` says unless the Project writes
 * its own.
 *
 * The last three are not a matter of taste. The checks that run after the agent
 * read the working tree of this one directory, so an agent that commits,
 * stashes or writes elsewhere produces nothing they can see, and the pass is
 * refused for having done nothing. A Project that replaces these keeps that
 * obligation whether or not it repeats the words.
 */
export const PROMPT_RULES = [
  "- Work only inside this directory. Do not read or edit anything outside it.",
  "- Follow the conventions already in this repository: its structure, its naming,",
  "  its tests. Read the code around what you touch before you write.",
  "- Change only what the task needs.",
  "- If the project has checks of its own, run them and leave them passing.",
  "- Nobody is watching this run and nobody will answer a question. Where the task",
  "  is ambiguous, take the reading most consistent with the existing code, and say",
  "  which one you took in your final message.",
  "- Leave your work uncommitted in the working tree: do not commit, branch, stash,",
  "  or reset. The changed files in this directory are the deliverable, and they are",
  "  read back from here exactly as you leave them.",
  "- Do not push, do not open a pull request, do not touch a remote.",
].join("\n");

const PLACEHOLDER = /\{\{\s*([a-z_]+)\s*\}\}/g;

export type Rendered = { ok: true; prompt: string } | { ok: false; reason: string };

/**
 * Fill a prompt template from a map of names the caller owns.
 *
 * An unknown name is refused rather than dropped: a typo that silently removes
 * the task is a run spent on nothing. `required` names must appear in the
 * template; an empty value still counts as placed. Blank lines an emptied
 * placeholder leaves are collapsed.
 */
export function renderPrompt(
  template: string,
  values: Record<string, string>,
  required: readonly string[] = [],
): Rendered {
  const unknown = new Set<string>();
  const seen = new Set<string>();
  const filled = template.replace(PLACEHOLDER, (match, name: string) => {
    const value = values[name];
    if (value === undefined) {
      unknown.add(name);
      return match;
    }
    seen.add(name);
    return value;
  });

  if (unknown.size > 0) {
    return {
      ok: false,
      reason: `The prompt template uses {{${[...unknown].join("}}, {{")}}}, which is not a placeholder. Known: {{${Object.keys(values).join("}}, {{")}}}.`,
    };
  }
  for (const name of required) {
    if (!seen.has(name)) {
      return { ok: false, reason: `The prompt template must place {{${name}}} somewhere.` };
    }
  }
  return { ok: true, prompt: `${filled.replace(/\n{3,}/g, "\n\n").trim()}\n` };
}

export type ReadTemplate = { ok: true; value: string } | { ok: false; reason: string };

/** The file at `path`, or `fallback` when there is no path. */
export function readTemplate(
  path: string | undefined,
  fallback: string,
  what = "prompt template",
): ReadTemplate {
  if (path === undefined) {
    return { ok: true, value: fallback };
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return {
      ok: false,
      reason: `Cannot read the ${what} at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  // An empty file is a truncated one far more often than it is a deliberate
  // silence, and a template with nothing in it wastes a whole run. A producing
  // template must place `{{rules}}`; a Project that wants other rules writes
  // them in a `--rules-file`.
  if (text.trim().length === 0) {
    return { ok: false, reason: `The ${what} at ${path} is empty.` };
  }
  return { ok: true, value: text };
}

/**
 * Options every vendor agent CLI takes: the prompt is already filled, and
 * nothing here is a placeholder.
 */
export const AGENT_OPTIONS: OptionSpec = {
  "--bin": {},
  "--model": {},
  "--output-format": { choices: ["json", "text", "stream-json"], fallback: "stream-json" },
  "--prompt": {},
  "--prompt-file": {},
  "--transcript-dir": {},
  "--transcript-part": { many: true, choices: TRANSCRIPT_PARTS },
  "--agent-arg": { many: true },
  "--id": {},
  "--attempt": {},
  "--context": {},
};

/**
 * The already-filled prompt an agent CLI was handed. `--prompt` and
 * `--prompt-file` are the same text, two ways in; both, or neither, is a
 * mistake. Nothing here interpolates.
 */
export function readAgentPrompt(
  options: OptionValues,
): { ok: true; prompt: string } | { ok: false; reason: string } {
  const inline = textOption(options, "prompt");
  const fromFile = textOption(options, "promptFile");
  if (inline !== undefined && fromFile !== undefined) {
    return { ok: false, reason: "Pass --prompt or --prompt-file, not both." };
  }
  if (inline !== undefined) {
    if (inline.trim().length === 0) {
      return { ok: false, reason: "The --prompt is empty." };
    }
    return { ok: true, prompt: inline };
  }
  if (fromFile === undefined) {
    return { ok: false, reason: "The agent command needs --prompt or --prompt-file." };
  }
  const loaded = readTemplate(fromFile, "");
  if (!loaded.ok) {
    return loaded;
  }
  return { ok: true, prompt: loaded.value };
}

export type TranscriptSubject = {
  slot?: string | undefined;
  bin?: string | undefined;
  args?: readonly string[] | undefined;
  prompt?: string | undefined;
};

/** The turn's transcript, filed under what this Task belongs to. */
export function transcriptFor(
  argv: readonly string[],
  options: OptionValues,
  about: TranscriptSubject,
): Transcript {
  const parts = options.transcriptPart;
  return openTranscript({
    dir: textOption(options, "transcriptDir"),
    ...(Array.isArray(parts) && parts.length > 0 ? { parts } : {}),
    context: take(argv, "--context"),
    id: take(argv, "--id"),
    attempt: take(argv, "--attempt"),
    ...about,
  });
}
