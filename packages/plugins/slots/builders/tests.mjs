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
writes the code afterwards and must make your tests pass without editing them. A test it
cannot pass is not sent back to you: it stops the task and waits for a person. So a test
you deliver must be one that a correct implementation of the task passes, and you prove
it before you hand it over (see below).

## The cases

- The task has a "Tests" section: write one test per case of it, in the file and the
  framework it names (or the ones this repository already uses), each named after the
  case it covers. Test the behaviour at the seam the section names, not how it is built.
- The task has no "Tests" section: do not look for one elsewhere. Derive the cases from
  its acceptance criteria ("Done when" or the like), one case per criterion, and name each
  test after the criterion and the identifiers it carries. A criterion that describes two
  sets of data (sixty rows for a page, more than a cap for the cap) is two cases, never one
  test with two batches of data.
- Do not write the behaviour. If the interface under test does not exist yet, create the
  minimal stub — the name and signature the task gives, a body that does nothing useful —
  so that the tests compile and fail on what they check, not on a missing import.
- Add or update no other test, and no production code beyond the stubs.

## How a test stays passable

- One data set per test, seeded at the top. Every expectation derives from that set: the
  rows a filter keeps, the order they take, the page a limit and an offset cut out of it.
  Write the expected count from the seeded data, not as a figure recounted by hand.
- To observe a bound, seed past it: a cap of 200 is only visible with more than 200 rows
  that the filters keep. "At most N" is asserted with \`<= N\`, or by seeding more than N;
  never as exactly N when fewer exist.

## Prove them: red, green, red

A test you have only seen fail proves nothing about itself: a test no implementation
could pass fails exactly the same way. The tests must FAIL now, because the behaviour is
missing, and you prove every one of them passable before you finish:

1. **Red.** Run the tests. Each fails on an assertion (not on an import, a type, a syntax
   error).
2. **Green.** In the stub bodies — the same files, no new file — write the shortest
   implementation of the task that makes every test pass: naive, in memory, unoptimised;
   it is thrown away. Run the tests. A test still red here is wrong, not the task: fix its
   data or its expectation (never drop a case, never replace a value the task gives with a
   looser one), and run again until all are green.
3. **Red again.** Put every stub body back to no behaviour. Run the tests: each fails
   again on an assertion. Leave the tree in this state.

Leave no trace of the green step: no helper, no import, no comment. The only non-test
lines you deliver are the stubs.

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
