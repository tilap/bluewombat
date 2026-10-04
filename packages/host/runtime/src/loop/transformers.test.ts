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

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "transformers-"));
}

function builderStage(gates: { id: string; argv: string[]; timeoutMs: number }[]) {
  const cmd = [node, join(fixtures, "builder-ok.mjs")];
  return {
    producer: { cmd, timeoutMs: 20_000 },
    repair: { cmd, timeoutMs: 20_000 },
    gates,
  };
}

function assemblyStage(
  gates: { id: string; argv: string[]; timeoutMs: number }[],
  validateCmd?: string[],
) {
  const cmd = [node, join(fixtures, "builder-ok.mjs")];
  return {
    fix: { cmd, timeoutMs: 20_000 },
    ...(validateCmd === undefined ? {} : { validate: { cmd: validateCmd, timeoutMs: 20_000 } }),
    gates,
  };
}

function transformersWith(gates: { id: string; argv: string[]; timeoutMs: number }[]) {
  return createTransformers({
    planner: { cmd: [node, "-e", ""], timeoutMs: 20_000 },
    builder: { ...builderStage(gates), maxAttempts: 1 },
    assembly: { ...assemblyStage(gates), maxAttempts: 1 },
    isolation: copyStrategy.isolation,
    fold: copyStrategy.fold,
    timeoutMs: 20_000,
    maxUnits: 10,
    maxFeatureBytes: 100_000,
  });
}

describe("createTransformers", () => {
  it("carries the reason a Gate refused, not only that it did", async () => {
    const transformers = transformersWith([
      { id: "lint", argv: [node, join(fixtures, "gate-fail-retryable.mjs")], timeoutMs: 10_000 },
    ]);
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
    const transformers = transformersWith([
      { id: "ok", argv: [node, join(fixtures, "gate-pass.mjs")], timeoutMs: 10_000 },
    ]);
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
    const transformers = createTransformers({
      planner: { cmd: [node, "-e", ""], timeoutMs: 20_000 },
      builder: {
        ...builderStage([
          { id: "local", argv: [node, join(fixtures, "gate-pass.mjs")], timeoutMs: 10_000 },
        ]),
        maxAttempts: 1,
      },
      assembly: {
        ...assemblyStage([
          {
            id: "published",
            argv: [node, join(fixtures, "gate-fail-retryable.mjs")],
            timeoutMs: 10_000,
          },
        ]),
        maxAttempts: 1,
      },
      isolation: copyStrategy.isolation,
      fold: copyStrategy.fold,
      timeoutMs: 20_000,
      maxUnits: 10,
      maxFeatureBytes: 100_000,
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
    // `assembly.gates` look at what was published. This pass has published
    // nothing yet, so they would refuse work that does not exist — while the
    // Project's own sequence still applies, as it does to any making pass.
    assert.equal(result.outcome, "validated");
  });

  it("gives a judgement one Attempt, since it makes nothing to judge again", async () => {
    const transformers = transformersWith([
      { id: "red", argv: [node, join(fixtures, "gate-fail-retryable.mjs")], timeoutMs: 10_000 },
    ]);
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
    const transformers = createTransformers({
      planner: { cmd: [node, "-e", ""], timeoutMs: 20_000 },
      builder: {
        ...builderStage([
          { id: "ok", argv: [node, join(fixtures, "gate-pass.mjs")], timeoutMs: 10_000 },
        ]),
        maxAttempts: 1,
      },
      assembly: { ...assemblyStage([]), maxAttempts: 1 },
      isolation: copyStrategy.isolation,
      fold: copyStrategy.fold,
      timeoutMs: 20_000,
      maxUnits: 10,
      maxFeatureBytes: 100_000,
      journal: { append: (line) => filmed.push(line) },
    });
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
      },
      builder: { ...builderStage([]), maxAttempts: 1 },
      assembly: { ...assemblyStage([]), maxAttempts: 1 },
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
    const transformers = createTransformers({
      planner: { cmd: [node, "-e", ""], timeoutMs: 20_000 },
      builder: { ...builderStage([]), maxAttempts: 3 },
      assembly: {
        ...assemblyStage(
          [{ id: "published", argv: [node, join(fixtures, "gate-pass.mjs")], timeoutMs: 10_000 }],
          [node, join(fixtures, "builder-fail-retryable.mjs")],
        ),
        maxAttempts: 3,
      },
      isolation: copyStrategy.isolation,
      fold: copyStrategy.fold,
      timeoutMs: 20_000,
      maxUnits: 10,
      maxFeatureBytes: 100_000,
    });
    const result = await transformers.implement({
      id: "t:validate",
      stage: "assembly",
      validate: true,
      intention: "i",
      workspace: workspace(),
    });
    // A single, read-only Attempt: assembly.gates would be looking at a
    // workspace validate never touches, and a second try would judge the same
    // diff again.
    assert.equal(result.outcome, "escalated");
    assert.equal(result.traces.length, 1);
    assert.equal(result.traces[0]?.report, "builder could not finish");
  });

  it("does not run assembly.validate when the Project declares none", async () => {
    const transformers = transformersWith([]);
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

  it("stops an assembly fix on Host's interrupt instead of waiting for the agent", async () => {
    const interruptFlag = { interrupted: false };
    const sleeper = [node, join(fixtures, "sleep.mjs"), "60000"];
    const transformers = createTransformers({
      planner: { cmd: [node, "-e", ""], timeoutMs: 20_000 },
      builder: { ...builderStage([]), maxAttempts: 1 },
      assembly: { fix: { cmd: sleeper, timeoutMs: 60_000 }, gates: [], maxAttempts: 1 },
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
