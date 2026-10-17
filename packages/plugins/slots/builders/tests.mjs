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

const NAME = "builder tests";

const DEFAULT_TEMPLATE = `You are a coding agent working unattended in a checkout of the project.

Task:
{{task}}

YOUR WORK NOW IS TO WRITE THE TESTS OF THIS TASK, AND ONLY THE TESTS. Another agent
writes the code afterwards and must make your tests pass without editing them.

- The task has a "Tests" section: write one test per case of it, in the file and the
  framework it names (or the ones this repository already uses), each named after the
  case it covers. Test the behaviour at the seam the section names, not how it is built.
- Do not write the behaviour. If the interface under test does not exist yet, create the
  minimal stub — the name and signature the section gives, a body that does nothing useful
  — so that the tests compile and fail on what they check, not on a missing import.
- The tests must FAIL now, because the behaviour is missing. Run them and see it. A test
  that passes before the code exists tests nothing: make it assert what is not there yet.
- If the section says "Tests: none", change nothing and say so in your final message.
- Add or update no other test, and no production code beyond the stubs.

{{history}}

## When you cannot act

If the cases are missing, or contradict the task or the code, do not invent them. Change
nothing and end your final message with exactly one line:

MASON_BLOCKED: <what is missing, in one line>

A person reads that line and decides. It is a correct answer, not a failure.

Rules of this run:
{{rules}}
`;

// A retry carries the refusal in --history; the flags themselves are consumed so the
// role options see only their own.
take(process.argv, "--report");
take(process.argv, "--report-from");

const intention = (take(process.argv, "--intention") ?? "").trim();
if (intention.length === 0) {
  emitFailure("fail-blocking", "The Builder received no --intention.");
  process.exit(1);
}

// A task that says `Tests: none` has nothing to write first: no agent runs for it.
if (/^\s*Tests:\s*none\b/im.test(intention)) {
  process.exit(0);
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
    history: (take(process.argv, "--history") ?? "").trim(),
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
