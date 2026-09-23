#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkPlan,
  emitPlan,
  emitRefusal,
  fillPrompt,
  loadPrompt,
  PLANNER_FLAGS,
  parseRole,
  spawnFilled,
  take,
  textOption,
  transcriptArgs,
  writeDiagnostic,
} from "@bluewombat/slot-kit";

const NAME = "planner producer";

const DEFAULT_TEMPLATE = `You are splitting one piece of work into an ordered list of subtasks.

You are not writing any of it. Do not modify anything in this directory. Read as
much of it as you need first: the split has to fit the project as it is. Do not
invent conventions you can discover from the repository.

The work:
{{intention}}

Treat that as the source of truth for the desired outcome, not as a finished
specification. Its wording may be incomplete. Separate what it explicitly
requires from what the repository or ordinary engineering practice implies.
Do not invent requirements to make the plan look complete.

How the subtasks will be run, which is what makes a good split:

- One at a time, never in parallel. Each runs in its own copy of this project,
  and its result is folded back before the next one starts. So a later subtask
  sees the earlier ones' work. If two slices would both change the same path
  (a README, an index or barrel file, a changelog, package.json, or any other
  shared file), make them **one** subtask, or give the second a \`depends_on\` on
  the first and let **only** that second one write the shared path. Do not invent
  a docs-only subtask unless the work asked for documentation.
- Every subtask is checked by the project's own checks — its tests, its lint —
  on its own. **A subtask must leave the project working.** This is the rule that
  decides your split: never cut by layer. "Add the types", then "add the code",
  then "add the tests" is wrong, because the first two leave the project broken.
  Cut by thin slices that each work end to end. Tests belong in the subtask that
  introduces or changes the behavior they verify.
- Each subtask is given to an agent with no memory of you and no memory of the
  others. Its intention has to stand alone: no "as discussed above", no knowledge
  of this planning process, no requirement that lives only in the original work
  description. Copy into the subtask everything its agent needs. A pointer at
  existing code is fine if it names the behavior or location clearly enough to
  investigate.
- Write each intention the way a good commit message is written: one headline
  of at most 72 characters in the imperative ("Add titleCase in
  src/title-case.js"), a blank line, then everything the agent needs. The
  headline is what people see: in the plan on the tracker, in the change list
  of the submission, on the commit.
- Its definition of done has to be checkable by someone who cannot read your
  mind, and preferably by a test. It describes this subtask's observable result,
  not the whole feature and not an intention.
- \`depends_on\` means "cannot start before this one is done", and nothing else.
  Sharing a file is a reason not to start side by side: pack those slices into
  one subtask, or make the later one depend on the earlier. The graph describes
  what must land before a merge is safe, not the order you happened to think in.
  Chaining every subtask to the one before it when their files do not overlap
  hides which ones were actually independent.

You are choosing between two costs, and both are real.

Splitting too finely costs a full agent run per slice, and each slice pays the
project's whole check sequence again. Do not create a subtask solely to read
code, decide what to implement, create folders, rename things, add comments,
write documentation (unless the work asked for it), clean up, or refactor
speculatively.

Not splitting enough costs more, and less visibly. One subtask is one agent run,
with one budget of attempts and one clock: a subtask too large for that exhausts
them and the whole piece of work stops. And a subtask that fails goes back to
nothing, while a subtask that succeeded is never redone. Ten modules in one
subtask means ten modules redone when the tenth goes wrong.

Prefer adapting what the project already does over introducing a parallel
mechanism. Do not propose an architectural change merely because it might be
cleaner.

So: as few subtasks as the work allows, and none larger than what one competent
engineer would finish in a single sitting without losing the thread. At most
{{max_units}}.

Write your answer as JSON, and nothing else, to this file:

{{out}}

It looks like this:

{
  "subtasks": [
    { "id": "s1", "intention": "Headline\\n\\nEverything the agent needs.", "definition_of_done": "...", "depends_on": [] },
    { "id": "s2", "intention": "Headline\\n\\n...", "definition_of_done": "...", "depends_on": ["s1"] }
  ]
}

If the work cannot be split as it is written — contradictory outcomes, a
critical requirement so ambiguous that the implementation would change with
the reading, or too little to determine what should be built — write this
instead, and do not invent a plan to fill the silence. Do not refuse merely
because some implementation details are unspecified; those come from the
repository.

{ "outcome": "refused", "reason": "..." }
`;

const intention = (take(process.argv, "--intention") ?? "").trim();
if (intention.length === 0) {
  fail("The Planner received no --intention.");
}

const parsed = parseRole(process.argv, PLANNER_FLAGS, NAME, { "--read": {} });
if (!parsed.ok) {
  fail(parsed.reason);
}

const template = loadPrompt(parsed.options, DEFAULT_TEMPLATE);
if (!template.ok) {
  fail(template.reason);
}

const maxUnits = Number.parseInt(take(process.argv, "--max-units") ?? "", 10);
const scratch = mkdtempSync(join(tmpdir(), "plan-"));
const out = join(scratch, "plan.json");
const cwd = textOption(parsed.options, "read") ?? process.cwd();

try {
  const rendered = fillPrompt(
    template.value,
    {
      intention,
      max_units: Number.isInteger(maxUnits) ? String(maxUnits) : "a handful",
      out,
    },
    ["intention", "out"],
    textOption(parsed.options, "promptFile") ?? "built-in template",
  );
  if (!rendered.ok) {
    fail(rendered.reason);
  }

  const spawned = await spawnFilled(
    parsed.runner,
    rendered.prompt,
    transcriptArgs(process.argv, {
      id: "breakdown",
      context: take(process.argv, "--key"),
    }),
    cwd,
  );
  if (!spawned.ok) {
    fail(spawned.reason);
  }
  if (spawned.run.error !== undefined) {
    fail(`Could not start the agent at ${spawned.about.bin}: ${spawned.run.error.message}`);
  }

  const answer = readAnswer(out);
  if (answer === undefined) {
    fail(`The agent wrote no usable plan to ${out}. ${tail(spawned.run.output)}`);
  }
  if (answer.outcome === "refused") {
    const reason =
      typeof answer.reason === "string" && answer.reason.trim().length > 0
        ? answer.reason.trim()
        : "The Planner refused without saying why.";
    emitRefusal(reason);
    process.exit(0);
  }

  const checked = checkPlan(answer.subtasks, maxUnits);
  if (!checked.ok) {
    fail(`The agent returned a plan that cannot be used: ${checked.reason}`);
  }
  emitPlan(
    checked.subtasks.map((subtask) => ({
      id: subtask.id,
      intention: subtask.intention,
      definition_of_done: subtask.definition_of_done,
      depends_on: subtask.depends_on,
    })),
  );
  process.exit(0);
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

/** @param {string | undefined} output */
function tail(output) {
  const trimmed = (output ?? "").trim();
  return trimmed.length === 0 ? "" : trimmed.slice(-1000);
}

/** @param {string} reason @returns {never} */
function fail(reason) {
  writeDiagnostic(`${reason}\n`);
  process.exit(1);
}
