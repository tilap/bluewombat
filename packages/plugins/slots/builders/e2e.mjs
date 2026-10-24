#!/usr/bin/env node
import {
  BUILDER_FLAGS,
  emitFailure,
  fillPrompt,
  finishRun,
  loadPrompt,
  loadRules,
  PROMPT_RULES,
  parseRole,
  spawnFilled,
  take,
  textOption,
  transcriptArgs,
} from "@bluewombat/slot-kit";
import { attemptOf } from "../lib/fill.mjs";

// The Ticket that holds a Feature's e2e acceptance suite. One command for its first pass and for
// a pass a Gate refused: the suite is written once from the scenarios of the task, and a refusal
// is about its form, so there is no second command to tell apart. `{{report}}` and
// `{{refused_by}}` are empty on a first pass; `{{refusal}}` is a ready-made paragraph about them.

const NAME = "builder e2e";

const DEFAULT_TEMPLATE = `You are a coding agent working unattended in a checkout of the project.

You write the acceptance suite of a feature. The task below lists its scenarios, agreed with the
operator before development, each with an id (E1, E2, ...).

Task:
{{task}}

- Write one test per scenario, in the end-to-end framework this project already uses, and
  start the name of each test with its scenario id ("E1 …"). Follow the scenario's steps and
  expected result as written; do not add, merge or drop one.
- List the ids in the manifest \`e2e/scenarios.json\`, a JSON array: ["E1", "E2"].
- Write only inside the suite folder (\`e2e/\`). Touch no file of the application, and add no
  dependency it does not already have.
- The feature is not finished here and the application is not started: do not run the suite. Check
  only that it compiles, with the project's own typecheck or build command.

{{refusal}}

{{history}}

## When you cannot act

If what you were given is not enough to act on (a scenario is ambiguous, the framework is missing,
the cause is outside this directory), do not invent a change. Change nothing and end your final
message with exactly one line:

MASON_BLOCKED: <what is missing, in one line>

A person reads that line and decides. It is a correct answer, not a failure.

Rules of this run:
{{rules}}
`;

const intention = (take(process.argv, "--intention") ?? "").trim();
if (intention.length === 0) {
  emitFailure("fail-blocking", "The Builder received no --intention.");
  process.exit(1);
}

const parsed = parseRole(process.argv, BUILDER_FLAGS, NAME);
if (!parsed.ok) {
  emitFailure("fail-blocking", parsed.reason);
  process.exit(1);
}

const template = loadPrompt(parsed.options, DEFAULT_TEMPLATE);
if (!template.ok) {
  emitFailure("fail-blocking", template.reason);
  process.exit(1);
}
const rules = loadRules(parsed.options, PROMPT_RULES);
if (!rules.ok) {
  emitFailure("fail-blocking", rules.reason);
  process.exit(1);
}

const report = (take(process.argv, "--report") ?? "").trim();
const refusedBy = (take(process.argv, "--report-from") ?? "").trim();
const refusal =
  report.length === 0
    ? ""
    : [
        "What is in this directory is what an earlier attempt left. It was refused",
        `${refusedBy.length > 0 ? `by ${refusedBy}` : "by a check"}:`,
        "",
        "```raw",
        report,
        "```",
        "",
        "Resolve that, change what it takes and nothing more.",
      ].join("\n");

const rendered = fillPrompt(
  template.value,
  {
    task: intention,
    history: (take(process.argv, "--history") ?? "").trim(),
    refusal,
    report,
    refused_by: refusedBy,
    rules: rules.value.trim(),
    id: take(process.argv, "--id") ?? "",
    attempt: String(attemptOf(process.argv)),
  },
  ["task", "rules"],
  textOption(parsed.options, "promptFile") ?? "built-in template",
);
if (!rendered.ok) {
  emitFailure("fail-blocking", rendered.reason);
  process.exit(1);
}

const spawned = await spawnFilled(parsed.runner, rendered.prompt, transcriptArgs(process.argv));
if (!spawned.ok) {
  emitFailure("fail-blocking", spawned.reason);
  process.exit(1);
}
finishRun({ run: spawned.run, bin: spawned.about.bin, name: spawned.about.name });
