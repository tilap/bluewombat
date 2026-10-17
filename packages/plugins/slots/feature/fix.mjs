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

const NAME = "feature fix";

const DEFAULT_TEMPLATE = `You are a coding agent working unattended in a checkout of the project.

This directory is a whole feature: the work of all its tickets, already
assembled and checked ticket by ticket. It was then brought up to date with the
branch it will be merged into, and checked again as a whole. Something refused
it after that: a merge conflict while bringing it up to date, a check that fails
on the result, or the project's CI. Do not redo the feature, or any ticket of
it. Fix what the refusal names.

Refused by: {{refused_by}}

What it said:

\`\`\`raw
{{report}}
\`\`\`

YOUR WORK NOW IS TO RESOLVE THAT. Change what it takes and nothing more; what is
already here and passes is not to be redone.

## According to who refused

- **A merge conflict** (refused by \`align\`): the report names the branch the
  feature is merged into. Look at what that branch changed since this feature
  started (compare the two with git), then edit the files in conflict so that
  both sets of changes hold: what the branch added stays, and the feature still
  does what it asks. Do not drop the branch's changes to keep yours. Leave the
  result uncommitted.
- **A check** (a gate named by its id, such as the typecheck or the tests): run
  the failing command here the way the gate ran it, see the error, fix the
  cause. The error often comes from what the target branch brought in, or from
  two tickets that were each fine alone: adapt the feature's code to it.
- **The CI**: reproduce the failing job's command here, then fix it. Change the
  work, not the CI definition.

## Original request

This was asked in the first place, and still holds:

{{task}}

{{history}}

## When you cannot act

If what you were given is not enough to act on (the refusal names nothing you
can read or run here, the request contradicts the rules of this run, or the
cause is outside this directory), do not invent a change. Change nothing and
end your final message with exactly one line:

MASON_BLOCKED: <what is missing, in one line>

A person reads that line and decides. It is a correct answer, not a failure.

## Rules of this run

{{rules}}
`;

const report = (take(process.argv, "--report") ?? "").trim();
if (report.length === 0) {
  emitFailure("fail-blocking", "The feature fix command needs --report.");
  process.exit(1);
}

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

const refusedBy = (take(process.argv, "--report-from") ?? "").trim();
const rendered = fillPrompt(
  template.value,
  {
    task: intention,
    history: (take(process.argv, "--history") ?? "").trim(),
    report,
    refused_by:
      refusedBy.length > 0 ? refusedBy : "the producer of the last attempt, which did not finish",
    rules: rules.value.trim(),
    id: take(process.argv, "--id") ?? "",
    attempt: String(attemptOf(process.argv)),
  },
  ["task", "report", "rules"],
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
