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

// The Ticket that holds a Feature's tests. One command for its first pass and for a pass a Gate
// refused: the tests are written once from the scenarios of the task, and a refusal is about their
// form, so there is no second command to tell apart. `{{report}}` and `{{refused_by}}` are empty
// on a first pass; `{{refusal}}` is a ready-made paragraph about them.

const NAME = "builder feature-test";

const DEFAULT_TEMPLATE = `You are a coding agent working unattended in a checkout of the project.

You write the tests of a feature. The task below lists its scenarios, agreed with the operator
before development, each with an id (S1, S2, ...). The feature is built: this checkout holds every
other Ticket of it.

Task:
{{task}}

- Write one test per scenario, in the test framework this project already uses, at the level the
  scenario describes (through the feature's public interfaces: routes, services, pages), and start
  the name of each test with its scenario id ("S1 …"). Follow the scenario's steps and expected
  result as written; do not add, merge, drop or weaken one. If a scenario changes a behaviour that
  existing tests describe, update those tests to the new behaviour, and only those.
- List the ids of the scenarios in the manifest \`feature-tests/scenarios.json\`, a JSON array:
  ["S1", "S2"]. Only the scenarios of this feature, never the project's other tests.
- Write only tests, their helpers and the manifest. Touch no file of the application, and add no
  dependency it does not already have.
- A Gate runs your tests against the built feature after every attempt and gives you its report
  (the refusal below). Read it: a test that fails for its own reasons (a wrong selector or wait, a
  wrong data setup, a misread expectation) is yours to fix. Check only that your tests compile
  before you finish, with the project's own typecheck or build command.
- If a test stays red because the feature does not do what the scenario says, do not change the
  application and do not weaken the test: that is a finding. Change nothing more and end with
  MASON_BLOCKED, naming the scenario, what the feature does instead and where.

{{refusal}}

{{history}}

## When you cannot act

If what you were given is not enough to act on (a scenario is ambiguous, cannot be written without
changing the application or without a weaker result than asked, the framework is missing, the
feature is wrong, the cause is outside this directory), do not invent a change and do not lower
the scenario. Change nothing and end your final message with exactly one line:

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
