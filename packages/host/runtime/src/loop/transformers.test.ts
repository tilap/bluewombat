import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { strategy as copyStrategy } from "@bluewombat/isolation-copy";
import { createTransformers } from "./transformers.js";

const node = process.execPath;
const fixtures = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../kernel/implementer/fixtures",
);

type GateSpec = { id: string; argv: string[]; timeoutMs: number };

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "transformers-"));
}

/**
 * Every role gets its own Gate list — none of these options share a bucket
 * with another, unlike the dispatch this replaced.
 */
function makeTransformers(
  opts: {
    builderProducerGates?: GateSpec[];
    builderRepairGates?: GateSpec[];
    builderMaxAttempts?: number;
    /** The produce:false judgement-only pass's own list — never fix's or validate's. */
    ticketGates?: GateSpec[];
    ticketFixGates?: GateSpec[];
    ticketValidateCmd?: string[];
    ticketValidateGates?: GateSpec[];
    ticketMaxAttempts?: number;
  } = {},
  over: Record<string, unknown> = {},
) {
  const cmd = [node, join(fixtures, "builder-ok.mjs")];
  return createTransformers({
    builder: {
      producer: { cmd, timeoutMs: 20_000, gates: opts.builderProducerGates ?? [] },
      repair: { cmd, timeoutMs: 20_000, gates: opts.builderRepairGates ?? [] },
      maxAttempts: opts.builderMaxAttempts ?? 1,
    },
    ticket: {
      fix: { cmd, timeoutMs: 20_000, gates: opts.ticketFixGates ?? [] },
      ...(opts.ticketValidateCmd === undefined
        ? {}
        : {
            validate: {
              cmd: opts.ticketValidateCmd,
              timeoutMs: 20_000,
              gates: opts.ticketValidateGates ?? [],
            },
          }),
      gates: opts.ticketGates ?? [],
      maxAttempts: opts.ticketMaxAttempts ?? 1,
    },
    isolation: copyStrategy.isolation,
    fold: copyStrategy.fold,
    timeoutMs: 20_000,
    ...over,
  });
}

describe("createTransformers", () => {
  it("carries the reason a Gate refused, not only that it did", async () => {
    const transformers = makeTransformers({
      builderProducerGates: [
        { id: "lint", argv: [node, join(fixtures, "gate-fail-retryable.mjs")], timeoutMs: 10_000 },
      ],
    });
    const result = await transformers.implement({
      id: "t",
      intention: "i",
      workspace: workspace(),
    });
    assert.equal(result.outcome, "escalated");
    // Whoever drives the next Attempt has to hand this to the producer, and
    // "it failed" is not something a producer can act on.
    assert.ok(
      (result.traces[0]?.report ?? "").length > 0,
      `no reason on the trace: ${JSON.stringify(result.traces)}`,
    );
    // Unattributed, it reaches the next producer as "something refused this".
    assert.equal(result.traces[0]?.refusedBy, "lint");
  });

  it("says nothing extra when the Attempt was validated", async () => {
    const transformers = makeTransformers({
      builderProducerGates: [
        { id: "ok", argv: [node, join(fixtures, "gate-pass.mjs")], timeoutMs: 10_000 },
      ],
    });
    const result = await transformers.implement({
      id: "t",
      intention: "i",
      workspace: workspace(),
    });
    assert.equal(result.outcome, "validated");
    assert.equal(result.traces[0]?.report, undefined);
  });

  it("does not judge a making pass with the sequence meant for the next one", async () => {
    const transformers = makeTransformers({
      ticketFixGates: [
        { id: "local", argv: [node, join(fixtures, "gate-pass.mjs")], timeoutMs: 10_000 },
      ],
      ticketGates: [
        {
          id: "published",
          argv: [node, join(fixtures, "gate-fail-retryable.mjs")],
          timeoutMs: 10_000,
        },
      ],
    });
    const result = await transformers.implement({
      id: "t:ticket",
      stage: "ticket",
      produce: true,
      intention: "i",
      workspace: workspace(),
      report: "the check went red",
    });
    // `ticket.gates` (the produce:false judgement pass) look at what was
    // published. This pass has published nothing yet — it is judged by
    // `ticket.fix`'s own sequence instead, which passes here.
    assert.equal(result.outcome, "validated");
  });

  it("gives a judgement one Attempt, since it makes nothing to judge again", async () => {
    const transformers = makeTransformers({
      ticketGates: [
        { id: "red", argv: [node, join(fixtures, "gate-fail-retryable.mjs")], timeoutMs: 10_000 },
      ],
    });
    const result = await transformers.implement({
      id: "t:judgement",
      stage: "ticket",
      produce: false,
      intention: "i",
      workspace: workspace(),
    });
    assert.equal(result.outcome, "escalated");
    assert.equal(result.traces.length, 1, "a second Attempt would judge the same thing again");
  });

  it("rechecks aligned work with the builder's Gates, and with no other list", async () => {
    const transformers = makeTransformers({
      builderProducerGates: [
        {
          id: "typecheck",
          argv: [node, join(fixtures, "gate-fail-retryable.mjs")],
          timeoutMs: 10_000,
        },
      ],
      ticketGates: [{ id: "ci", argv: [node, join(fixtures, "gate-pass.mjs")], timeoutMs: 10_000 }],
      ticketFixGates: [
        { id: "fix", argv: [node, join(fixtures, "gate-pass.mjs")], timeoutMs: 10_000 },
      ],
    });
    const result = await transformers.implement({
      id: "t:recheck",
      stage: "ticket",
      produce: false,
      recheck: true,
      intention: "i",
      workspace: workspace(),
    });
    // The builder's list refuses; the ticket lists would have passed.
    assert.equal(result.outcome, "escalated");
    assert.equal(result.traces[0]?.refusedBy, "typecheck");
    assert.equal(result.traces.length, 1, "a recheck makes nothing, so one Attempt is all it gets");
  });

  it("journals every progress line, including ones the Trace drops", async () => {
    const filmed: Record<string, unknown>[] = [];
    const transformers = makeTransformers(
      {
        builderProducerGates: [
          { id: "ok", argv: [node, join(fixtures, "gate-pass.mjs")], timeoutMs: 10_000 },
        ],
      },
      { journal: { append: (line: Record<string, unknown>) => filmed.push(line) } },
    );
    const result = await transformers.implement({
      id: "t",
      intention: "i",
      workspace: workspace(),
    });
    assert.equal(result.outcome, "validated");
    const events = filmed.map((line) => line.event);
    assert.equal(events.includes("status"), true);
    assert.equal(events.includes("gate-finished"), true);
  });

  it("runs ticket.validate with no gates and one attempt, and carries its report", async () => {
    const transformers = makeTransformers({
      builderMaxAttempts: 3,
      ticketMaxAttempts: 3,
      ticketGates: [
        { id: "published", argv: [node, join(fixtures, "gate-pass.mjs")], timeoutMs: 10_000 },
      ],
      ticketValidateCmd: [node, join(fixtures, "builder-fail-retryable.mjs")],
    });
    const result = await transformers.implement({
      id: "t:validate",
      stage: "ticket",
      validate: true,
      intention: "i",
      workspace: workspace(),
    });
    // A single Attempt: validate has no Attempt budget of its own to retry
    // against the same diff.
    assert.equal(result.outcome, "escalated");
    assert.equal(result.traces.length, 1);
    assert.equal(result.traces[0]?.report, "builder could not finish");
  });

  it("checks ticket.validate against its own gates, not builder.producer's", async () => {
    const transformers = makeTransformers({
      builderProducerGates: [
        {
          id: "unrelated",
          argv: [node, join(fixtures, "gate-fail-retryable.mjs")],
          timeoutMs: 10_000,
        },
      ],
      ticketValidateCmd: [node, join(fixtures, "builder-ok.mjs")],
    });
    const result = await transformers.implement({
      id: "t:validate",
      stage: "ticket",
      validate: true,
      intention: "i",
      workspace: workspace(),
    });
    // builder.producer's always-failing Gate never runs against a validate
    // Attempt — each role's Gate list is independent.
    assert.equal(result.outcome, "validated");
  });

  it("escalates ticket.validate when its own gates refuse it", async () => {
    const transformers = makeTransformers({
      ticketValidateCmd: [node, join(fixtures, "builder-ok.mjs")],
      ticketValidateGates: [
        {
          id: "own-check",
          argv: [node, join(fixtures, "gate-fail-retryable.mjs")],
          timeoutMs: 10_000,
        },
      ],
    });
    const result = await transformers.implement({
      id: "t:validate",
      stage: "ticket",
      validate: true,
      intention: "i",
      workspace: workspace(),
    });
    assert.equal(result.outcome, "escalated");
    assert.equal(result.traces[0]?.refusedBy, "own-check");
  });

  it("does not run ticket.validate when the Project declares none", async () => {
    const transformers = makeTransformers();
    const result = await transformers.implement({
      id: "t:validate",
      stage: "ticket",
      validate: true,
      intention: "i",
      workspace: workspace(),
    });
    // Nothing to produce: the Attempt makes nothing and there is nothing to
    // judge, so it validates trivially rather than failing on a missing slot.
    assert.equal(result.outcome, "validated");
  });

  it("gives builder.producer and builder.repair independent Gate sequences", async () => {
    const producerOnly = makeTransformers({
      builderProducerGates: [
        {
          id: "producer-red",
          argv: [node, join(fixtures, "gate-fail-retryable.mjs")],
          timeoutMs: 10_000,
        },
      ],
      builderMaxAttempts: 2,
    });
    const first = await producerOnly.implement({
      id: "t:producer-only",
      intention: "i",
      workspace: workspace(),
    });
    // Attempt 1 (producer) is refused by its own Gate; Attempt 2 (repair) has
    // no Gate of its own, so it validates instead of inheriting the producer's.
    assert.equal(first.outcome, "validated");
    assert.equal(first.traces.length, 2);

    const repairOnly = makeTransformers({
      builderRepairGates: [
        {
          id: "repair-red",
          argv: [node, join(fixtures, "gate-fail-retryable.mjs")],
          timeoutMs: 10_000,
        },
      ],
      builderMaxAttempts: 1,
    });
    const second = await repairOnly.implement({
      id: "t:repair-only",
      intention: "i",
      workspace: workspace(),
      report: "something refused it",
    });
    // A report present from Attempt 1 sends it straight to repair, which this
    // Project's own Gate refuses — with no producer Gate declared to compare.
    assert.equal(second.outcome, "escalated");
    assert.equal(second.traces[0]?.refusedBy, "repair-red");
  });

  it("stops an ticket fix on Host's interrupt instead of waiting for the agent", async () => {
    const interruptFlag = { interrupted: false };
    const sleeper = [node, join(fixtures, "sleep.mjs"), "60000"];
    const transformers = createTransformers({
      builder: {
        producer: { cmd: [node, join(fixtures, "builder-ok.mjs")], timeoutMs: 20_000, gates: [] },
        repair: { cmd: [node, join(fixtures, "builder-ok.mjs")], timeoutMs: 20_000, gates: [] },
        maxAttempts: 1,
      },
      ticket: { fix: { cmd: sleeper, timeoutMs: 60_000, gates: [] }, gates: [], maxAttempts: 1 },
      isolation: copyStrategy.isolation,
      fold: copyStrategy.fold,
      timeoutMs: 20_000,
      interruptFlag,
    });
    const started = Date.now();
    const pending = transformers.implement({
      id: "t:ticket",
      stage: "ticket",
      intention: "i",
      report: "ci-green refused",
      workspace: workspace(),
    });
    setTimeout(() => {
      interruptFlag.interrupted = true;
    }, 100);
    const result = await pending;
    // SIGINT only flips Host's flag. Not handed on, a fix agent keeps the run
    // alive for as long as it likes, and only a SIGKILL ends it.
    assert.equal(result.outcome, "interrupted");
    assert.ok(Date.now() - started < 10_000, `took ${Date.now() - started} ms`);
  });
});
