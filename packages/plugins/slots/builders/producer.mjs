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
import { attemptOf, doneWhen } from "../lib/fill.mjs";

const NAME = "builder producer";

const DEFAULT_TEMPLATE = `You are a coding agent working unattended in a checkout of the project.

Task:
{{task}}

{{done_when}}

This checkout already includes any earlier subtasks that were folded into the
feature. Do not rewrite that work. Add or change only what this task names, and
leave the project's own checks green on the whole tree.

Rules of this run:
{{rules}}
`;

const report = (take(process.argv, "--report") ?? "").trim();
if (report.length > 0) {
  emitFailure(
    "fail-blocking",
    "The builder producer is the first-pass command; a report belongs to the repair command.",
  );
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

const rendered = fillPrompt(
  template.value,
  {
    task: intention,
    done_when: doneWhen(take(process.argv, "--definition-of-done")),
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
