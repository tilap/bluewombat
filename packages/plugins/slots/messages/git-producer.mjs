#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emitMessage,
  fillPrompt,
  loadPrompt,
  loadRules,
  MESSAGE_FLAGS,
  parseRole,
  spawnFilled,
  take,
  textOption,
  transcriptArgs,
  writeDiagnostic,
} from "@bluewombat/slot-kit";

// The feature's commit message — and the pull request's description with it
// — written by an agent that read the diff, under the Project's own rules.
// Asked once per feature. A role slot like the builders: it fills a template
// and hands it to the agent after `--`; the agent answers in a file this slot
// reads back. `--prompt-file` replaces the template, `--rules-file` the rules
// — that is where a team's commit guideline goes.

const NAME = "message producer";

const DEFAULT_RULES = `- One subject line, imperative mood, at most 72 characters, no trailing period.
- Say what the change does for the reader of the history, not how it was made.
- A body only when the subject cannot carry the why; wrap it at 72.
- Nothing about tools, agents, or this process.`;

const DEFAULT_TEMPLATE = `You are writing the commit message for the change in this directory. It
is also what the pull request will say, so it is read by people.

Read the change first — \`git log {{target}}..HEAD\` for the commits that make
it up, \`git diff {{target}}...HEAD\` for what they change. Do not modify
anything.

What was asked ({{id}}):

{{title}}

{{intention}}

Rules:
{{rules}}

Write your answer as JSON, and nothing else, to this file:

{{out}}

It looks like this:

{ "subject": "…", "body": "…" }

\`body\` may be omitted.
`;

const title = (take(process.argv, "--title") ?? "").trim();
const intention = (take(process.argv, "--intention") ?? "").trim();
if (title.length === 0) {
  fail("The message producer received no --title.");
}

const parsed = parseRole(process.argv, MESSAGE_FLAGS, NAME);
if (!parsed.ok) {
  fail(parsed.reason);
}
const template = loadPrompt(parsed.options, DEFAULT_TEMPLATE);
if (!template.ok) {
  fail(template.reason);
}
const rules = loadRules(parsed.options, DEFAULT_RULES);
if (!rules.ok) {
  fail(rules.reason);
}

const scratch = mkdtempSync(join(tmpdir(), "message-"));
const out = join(scratch, "message.json");
try {
  const rendered = fillPrompt(
    template.value,
    {
      title,
      intention,
      target: take(process.argv, "--target") ?? "",
      id: take(process.argv, "--id") ?? "",
      rules: rules.value.trim(),
      out,
    },
    ["title", "out"],
    textOption(parsed.options, "promptFile") ?? "built-in template",
  );
  if (!rendered.ok) {
    fail(rendered.reason);
  }
  const spawned = await spawnFilled(
    parsed.runner,
    rendered.prompt,
    transcriptArgs(process.argv, { id: `message:${take(process.argv, "--id") ?? ""}` }),
  );
  if (!spawned.ok) {
    fail(spawned.reason);
  }
  if (spawned.run.error !== undefined) {
    fail(`Could not start the agent at ${spawned.about.bin}: ${spawned.run.error.message}`);
  }
  const answer = readAnswer(out);
  if (answer === undefined || typeof answer.subject !== "string" || answer.subject.trim() === "") {
    fail(`The agent wrote no usable message to ${out}.`);
  }
  emitMessage(
    answer.subject.trim(),
    typeof answer.body === "string" && answer.body.trim().length > 0
      ? answer.body.trim()
      : undefined,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

/** @param {string} path @returns {Record<string, unknown> | undefined} */
function readAnswer(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  for (const candidate of [fenced?.[1], text]) {
    if (candidate === undefined) {
      continue;
    }
    try {
      const value = JSON.parse(candidate);
      if (value !== null && typeof value === "object") {
        return value;
      }
    } catch {
      // try the next reading
    }
  }
  return undefined;
}

/** @param {string} reason @returns {never} */
function fail(reason) {
  writeDiagnostic(`${reason}\n`);
  process.exit(1);
}
