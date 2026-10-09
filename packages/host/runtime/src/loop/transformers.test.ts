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
    assemblyGates?: GateSpec[];
    assemblyFixGates?: GateSpec[];
    assemblyValidateCmd?: string[];
    assemblyValidateGates?: GateSpec[];
    assemblyMaxAttempts?: number;
  } = {},
  over: Record<string, unknown> = {},
) {
  const cmd = [node, join(fixtures, "builder-ok.mjs")];
  return createTransformers({
    planner: { cmd: [node, "-e", ""], timeoutMs: 20_000, gates: [] },
    builder: {
      producer: { cmd, timeoutMs: 20_000, gates: opts.builderProducerGates ?? [] },
      repair: { cmd, timeoutMs: 20_000, gates: opts.builderRepairGates ?? [] },
      maxAttempts: opts.builderMaxAttempts ?? 1,
    },
    assembly: {
      fix: { cmd, timeoutMs: 20_000, gates: opts.assemblyFixGates ?? [] },
      ...(opts.assemblyValidateCmd === undefined
        ? {}
        : {
            validate: {
              cmd: opts.assemblyValidateCmd,
              timeoutMs: 20_000,
              gates: opts.assemblyValidateGates ?? [],
            },
          }),
      gates: opts.assemblyGates ?? [],
      maxAttempts: opts.assemblyMaxAttempts ?? 1,
    },
    workLineStable: workspace(),
    isolation: copyStrategy.isolation,
    fold: copyStrategy.fold,
    timeoutMs: 20_000,
    maxUnits: 10,
    maxFeatureBytes: 100_000,
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
      definitionOfDone: "d",
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
      definitionOfDone: "d",
      workspace: workspace(),
    });
    assert.equal(result.outcome, "validated");
    assert.equal(result.traces[0]?.report, undefined);
  });

  it("does not judge a making pass with the sequence meant for the next one", async () => {
    const transformers = makeTransformers({
      assemblyFixGates: [
        { id: "local", argv: [node, join(fixtures, "gate-pass.mjs")], timeoutMs: 10_000 },
      ],
      assemblyGates: [
        {
          id: "published",
          argv: [node, join(fixtures, "gate-fail-retryable.mjs")],
          timeoutMs: 10_000,
        },
      ],
    });
    const result = await transformers.implement({
      id: "t:assembly",
      stage: "assembly",
      produce: true,
      intention: "i",
      definitionOfDone: "d",
      workspace: workspace(),
      report: "the check went red",
    });
    // `assembly.gates` (the produce:false judgement pass) look at what was
    // published. This pass has published nothing yet — it is judged by
    // `assembly.fix`'s own sequence instead, which passes here.
    assert.equal(result.outcome, "validated");
  });

  it("gives a judgement one Attempt, since it makes nothing to judge again", async () => {
    const transformers = makeTransformers({
      assemblyGates: [
        { id: "red", argv: [node, join(fixtures, "gate-fail-retryable.mjs")], timeoutMs: 10_000 },
      ],
    });
    const result = await transformers.implement({
      id: "t:judgement",
      stage: "assembly",
      produce: false,
      intention: "i",
      definitionOfDone: "d",
      workspace: workspace(),
    });
    assert.equal(result.outcome, "escalated");
    assert.equal(result.traces.length, 1, "a second Attempt would judge the same thing again");
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
      definitionOfDone: "d",
      workspace: workspace(),
    });
    assert.equal(result.outcome, "validated");
    const events = filmed.map((line) => line.event);
    assert.equal(events.includes("status"), true);
    assert.equal(events.includes("gate-finished"), true);
  });

  it("prints why a Planner that wrote no plan is unavailable", async () => {
    const said: string[] = [];
    const slots = join(dirname(fileURLToPath(import.meta.url)), "../../../../plugins/slots");
    const transformers = createTransformers({
      planner: {
        cmd: [
          node,
          join(slots, "planners/producer.mjs"),
          "--",
          node,
          join(slots, "agents/cursor.mjs"),
          "--bin",
          join(slots, "fixtures/planner-agent-silent.mjs"),
        ],
        timeoutMs: 20_000,
        gates: [],
      },
      builder: {
        producer: { cmd: [node, join(fixtures, "builder-ok.mjs")], timeoutMs: 20_000, gates: [] },
        repair: { cmd: [node, join(fixtures, "builder-ok.mjs")], timeoutMs: 20_000, gates: [] },
        maxAttempts: 1,
      },
      assembly: {
        fix: { cmd: [node, join(fixtures, "builder-ok.mjs")], timeoutMs: 20_000, gates: [] },
        gates: [],
        maxAttempts: 1,
      },
      workLineStable: workspace(),
      isolation: copyStrategy.isolation,
      fold: copyStrategy.fold,
      timeoutMs: 20_000,
      maxUnits: 10,
      maxFeatureBytes: 100_000,
      trace: (line) => said.push(line),
    });
    const result = await transformers.breakDown({
      featureJson: JSON.stringify({
        key: "github:tilap/web-emojis#3",
        intention: "Add a light/dark theme",
      }),
    });
    assert.equal(result.outcome, "unavailable");
    const text = said.join("\n");
    assert.match(text, /unavailable:github:tilap\/web-emojis#3/);
    assert.match(text, /no usable plan/);
  });

  it("runs assembly.validate with no gates and one attempt, and carries its report", async () => {
    const transformers = makeTransformers({
      builderMaxAttempts: 3,
      assemblyMaxAttempts: 3,
      assemblyGates: [
        { id: "published", argv: [node, join(fixtures, "gate-pass.mjs")], timeoutMs: 10_000 },
      ],
      assemblyValidateCmd: [node, join(fixtures, "builder-fail-retryable.mjs")],
    });
    const result = await transformers.implement({
      id: "t:validate",
      stage: "assembly",
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

  it("checks assembly.validate against its own gates, not builder.producer's", async () => {
    const transformers = makeTransformers({
      builderProducerGates: [
        {
          id: "unrelated",
          argv: [node, join(fixtures, "gate-fail-retryable.mjs")],
          timeoutMs: 10_000,
        },
      ],
      assemblyValidateCmd: [node, join(fixtures, "builder-ok.mjs")],
    });
    const result = await transformers.implement({
      id: "t:validate",
      stage: "assembly",
      validate: true,
      intention: "i",
      workspace: workspace(),
    });
    // builder.producer's always-failing Gate never runs against a validate
    // Attempt — each role's Gate list is independent.
    assert.equal(result.outcome, "validated");
  });

  it("escalates assembly.validate when its own gates refuse it", async () => {
    const transformers = makeTransformers({
      assemblyValidateCmd: [node, join(fixtures, "builder-ok.mjs")],
      assemblyValidateGates: [
        {
          id: "own-check",
          argv: [node, join(fixtures, "gate-fail-retryable.mjs")],
          timeoutMs: 10_000,
        },
      ],
    });
    const result = await transformers.implement({
      id: "t:validate",
      stage: "assembly",
      validate: true,
      intention: "i",
      workspace: workspace(),
    });
    assert.equal(result.outcome, "escalated");
    assert.equal(result.traces[0]?.refusedBy, "own-check");
  });

  it("does not run assembly.validate when the Project declares none", async () => {
    const transformers = makeTransformers();
    const result = await transformers.implement({
      id: "t:validate",
      stage: "assembly",
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
      definitionOfDone: "d",
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
      definitionOfDone: "d",
      workspace: workspace(),
      report: "something refused it",
    });
    // A report present from Attempt 1 sends it straight to repair, which this
    // Project's own Gate refuses — with no producer Gate declared to compare.
    assert.equal(second.outcome, "escalated");
    assert.equal(second.traces[0]?.refusedBy, "repair-red");
  });

  it("wires a planner's workspace and gates from workLineStable and planner.gates", async () => {
    const stable = workspace();
    const transformers = createTransformers({
      planner: {
        cmd: [node, join(fixtures, "../../feature-breakdown/fixtures", "planner-ok.mjs")],
        timeoutMs: 20_000,
        gates: [],
      },
      builder: {
        producer: { cmd: [node, join(fixtures, "builder-ok.mjs")], timeoutMs: 20_000, gates: [] },
        repair: { cmd: [node, join(fixtures, "builder-ok.mjs")], timeoutMs: 20_000, gates: [] },
        maxAttempts: 1,
      },
      assembly: {
        fix: { cmd: [node, join(fixtures, "builder-ok.mjs")], timeoutMs: 20_000, gates: [] },
        gates: [],
        maxAttempts: 1,
      },
      workLineStable: stable,
      isolation: copyStrategy.isolation,
      fold: copyStrategy.fold,
      timeoutMs: 20_000,
      maxUnits: 10,
      maxFeatureBytes: 100_000,
    });
    const result = await transformers.breakDown({
      featureJson: JSON.stringify({ key: "fake:1", intention: "do it" }),
    });
    assert.equal(result.outcome, "planned");
  });

  it("stops an assembly fix on Host's interrupt instead of waiting for the agent", async () => {
    const interruptFlag = { interrupted: false };
    const sleeper = [node, join(fixtures, "sleep.mjs"), "60000"];
    const transformers = createTransformers({
      planner: { cmd: [node, "-e", ""], timeoutMs: 20_000, gates: [] },
      builder: {
        producer: { cmd: [node, join(fixtures, "builder-ok.mjs")], timeoutMs: 20_000, gates: [] },
        repair: { cmd: [node, join(fixtures, "builder-ok.mjs")], timeoutMs: 20_000, gates: [] },
        maxAttempts: 1,
      },
      assembly: { fix: { cmd: sleeper, timeoutMs: 60_000, gates: [] }, gates: [], maxAttempts: 1 },
      workLineStable: workspace(),
      isolation: copyStrategy.isolation,
      fold: copyStrategy.fold,
      timeoutMs: 20_000,
      interruptFlag,
      maxUnits: 10,
      maxFeatureBytes: 100_000,
    });
    const started = Date.now();
    const pending = transformers.implement({
      id: "t:assembly",
      stage: "assembly",
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
