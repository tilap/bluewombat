#!/usr/bin/env node
import {
  BUILDER_FLAGS,
  emitFailure,
  failureOf,
  fillPrompt,
  loadPrompt,
  loadRules,
  parseRole,
  readResult,
  spawnFilled,
  take,
  textOption,
  transcriptArgs,
} from "@bluewombat/slot-kit";
import { attemptOf } from "../lib/fill.mjs";

const NAME = "assembly validate";

const DEFAULT_TEMPLATE = `You are a coding agent working unattended in a checkout of the project.

This directory is the assembled feature. Every unit of work that makes it up
has already been validated on its own. Your job now is different: read the
diff this feature carries against the work line it will land on, and judge
whether the WHOLE meets what was asked. Do not redo the units. Do not change
anything — this is a read-only review, not a repair.

## What was asked

{{task}}

## Your answer

End your final message with exactly one line in this form, and nothing after
it:

- \`MASON_VERDICT: VALIDATED\` — the assembled feature meets what was asked.
- \`MASON_VERDICT: REFUSED: <one paragraph>\` — it does not, and the paragraph
  says what is wrong, specifically enough for another agent to fix it without
  redoing your review. Keep the whole paragraph on that one line.

Nothing else may start a line with \`MASON_VERDICT:\`. You may explain your
reasoning before it, but that line is what is read — write it last.

## Rules of this run

{{rules}}
`;

/**
 * A reviewer's bounds: read-only, and answer in the one shape the caller
 * parses. `PROMPT_RULES` tells a producer to leave work uncommitted and push
 * nothing — obligations a Task that writes nothing does not have.
 */
const DEFAULT_RULES = [
  "- Work only inside this directory. Do not read or edit anything outside it.",
  "- This is a review, not a repair: do not change, stage, commit, or stash any file.",
  "- Judge the diff against the intention above, not the style of the units that made it.",
  "- Nobody is watching this run and nobody will answer a question. Where the intention is",
  "  ambiguous, take the reading most consistent with the existing code, and say which one",
  "  you took in your answer.",
  "- End your final message with one line: MASON_VERDICT: VALIDATED, or",
  "  MASON_VERDICT: REFUSED: <one paragraph, on that one line>.",
].join("\n");

const report = (take(process.argv, "--report") ?? "").trim();
if (report.length > 0) {
  emitFailure(
    "fail-blocking",
    "assembly.validate is a read-only review; it does not take --report — that is assembly.fix's job.",
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
const rules = loadRules(parsed.options, DEFAULT_RULES);
if (!rules.ok) {
  emitFailure("fail-blocking", rules.reason);
  process.exit(1);
}

const rendered = fillPrompt(
  template.value,
  {
    task: intention,
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

answer(spawned.run, spawned.about.bin, spawned.about.name);

/**
 * Read the agent's own verdict and map it through `emitFailure` — never
 * through exit 0 alone. A review that completes cleanly still has to answer
 * whether the work is right; the CLI exiting 0 only says the review ran.
 *
 * @param {import("@bluewombat/slot-kit").AgentRun} run
 * @param {string} bin
 * @param {string} name
 * @returns {never}
 */
function answer(run, bin, name) {
  if (run.error !== undefined || run.code !== 0) {
    const failure = failureOf(run, bin, name);
    emitFailure(failure.outcome, failure.report);
    process.exit(1);
  }
  const result = readResult(run.stdout);
  if (result?.is_error === true) {
    const failure = failureOf(run, bin, name);
    emitFailure(failure.outcome, failure.report);
    process.exit(1);
  }
  const said = typeof result?.result === "string" ? result.result.trim() : "";
  const verdict = lastVerdictLine(said);
  if (verdict === undefined) {
    // No `MASON_VERDICT:` line at all is not a pass on the strength of exit 0.
    // Treated as retryable, the same as any other malformed Attempt — the
    // next round gets the same prompt again.
    emitFailure(
      "fail-retryable",
      `assembly.validate found no MASON_VERDICT: line in the answer: ${
        said.length > 0 ? said.slice(0, 500) : "(no answer)"
      }`,
    );
    process.exit(1);
  }
  const refused = /^REFUSED:?\s*/i.exec(verdict);
  if (refused !== null) {
    const why = verdict.slice(refused[0].length).trim();
    emitFailure(
      "fail-retryable",
      why.length > 0
        ? why
        : "assembly.validate refused the assembled feature, with no reason given.",
    );
    process.exit(1);
  }
  if (/^VALIDATED\b/i.test(verdict)) {
    process.exit(0);
  }
  emitFailure(
    "fail-retryable",
    `assembly.validate's MASON_VERDICT: line was neither VALIDATED nor REFUSED: ${verdict.slice(0, 500)}`,
  );
  process.exit(1);
}

/**
 * The text after the last line that starts with `MASON_VERDICT:`, or
 * `undefined` when no such line exists.
 *
 * A distinctive, unlikely-to-collide marker, anchored to the start of a line
 * — not a bare search for "VALIDATED" or "REFUSED" anywhere in the answer,
 * which a model's own reasoning can contain by accident ("the units were
 * already validated on their own"). The *last* such line wins: a model that
 * restates its conclusion, or that is shown an example in the prompt, still
 * means its final one.
 *
 * @param {string} text
 * @returns {string | undefined}
 */
function lastVerdictLine(text) {
  const marker = /^MASON_VERDICT:\s*/i;
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = (lines[i] ?? "").trim();
    const match = marker.exec(line);
    if (match !== null) {
      return line.slice(match[0].length).trim();
    }
  }
  return undefined;
}
