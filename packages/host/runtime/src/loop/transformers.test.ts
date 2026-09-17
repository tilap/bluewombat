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

function assemblyStage(gates: { id: string; argv: string[]; timeoutMs: number }[]) {
  const cmd = [node, join(fixtures, "builder-ok.mjs")];
  return {
    fix: { cmd, timeoutMs: 20_000 },
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
});
