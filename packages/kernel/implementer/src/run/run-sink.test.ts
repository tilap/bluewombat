import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { ChildAbout, ChildSink, Invocation } from "../types.js";
import { runImplementer } from "./run-implementer.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures");
const node = process.execPath;

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "implementer-sink-"));
}

function baseInvocation(over: Partial<Invocation> & Pick<Invocation, "workspace">): Invocation {
  return {
    id: "task-1",
    intention: "ship it",
    definitionOfDone: "green",
    builderArgv: [node, join(fixtures, "builder-ok.mjs")],
    gates: [],
    repairGates: [],
    maxAttempts: 3,
    builderTimeoutMs: 10_000,
    ...over,
  };
}

type Recorded = {
  about: ChildAbout;
  chunks: { stream: string; text: string }[];
  closes: number;
};

/** A sink that remembers everything, so a test can say what a child said. */
function recorder(): { onChild: (about: ChildAbout) => ChildSink; opened: Recorded[] } {
  const opened: Recorded[] = [];
  return {
    opened,
    onChild(about) {
      const entry: Recorded = { about, chunks: [], closes: 0 };
      opened.push(entry);
      return {
        write(stream, text) {
          entry.chunks.push({ stream, text });
        },
        close() {
          entry.closes += 1;
        },
      };
    },
  };
}

describe("what a child says, as it says it", () => {
  it("a producer's two streams reach the sink, named apart", async () => {
    const sink = recorder();
    const result = await runImplementer({
      invocation: baseInvocation({
        workspace: workspace(),
        builderArgv: [node, join(fixtures, "builder-talks.mjs")],
      }),
      onChild: sink.onChild,
    });

    assert.equal(result.outcome, "validated");
    assert.equal(sink.opened.length, 1);
    const [child] = sink.opened;
    assert.equal(child?.about.kind, "builder");
    assert.equal(child?.about.task_id, "task-1");
    assert.equal(child?.about.attempt, 1);
    const said = (stream: string): string =>
      (child?.chunks ?? [])
        .filter((chunk) => chunk.stream === stream)
        .map((chunk) => chunk.text)
        .join("");
    assert.match(said("stdout"), /on stdout/);
    assert.match(said("stderr"), /on stderr/);
  });

  it("each Gate is its own child, and names which Gate it was", async () => {
    const sink = recorder();
    await runImplementer({
      invocation: baseInvocation({
        workspace: workspace(),
        maxAttempts: 1,
        gates: [
          { id: "first", argv: [node, join(fixtures, "gate-pass.mjs")], timeoutMs: 10_000 },
          { id: "second", argv: [node, join(fixtures, "gate-pass.mjs")], timeoutMs: 10_000 },
        ],
      }),
      onChild: sink.onChild,
    });

    const gates = sink.opened.filter((child) => child.about.kind === "gate");
    assert.deepEqual(
      gates.map((child) => child.about.gate_id),
      ["first", "second"],
    );
  });

  it("the sink carries the feature the Task serves, when Implementer was told it", async () => {
    const sink = recorder();
    await runImplementer({
      invocation: baseInvocation({ workspace: workspace(), context: "fake:42" }),
      onChild: sink.onChild,
    });

    assert.equal(sink.opened[0]?.about.key, "fake:42");
  });

  it("no context, no key: this Transformer never invents one", async () => {
    const sink = recorder();
    await runImplementer({
      invocation: baseInvocation({ workspace: workspace() }),
      onChild: sink.onChild,
    });

    assert.equal(sink.opened[0]?.about.key, undefined);
  });

  it("a child that is killed still closes its sink, exactly once", async () => {
    const sink = recorder();
    const result = await runImplementer({
      invocation: baseInvocation({
        workspace: workspace(),
        maxAttempts: 1,
        builderArgv: [node, join(fixtures, "sleep.mjs"), "60000"],
        builderTimeoutMs: 50,
      }),
      onChild: sink.onChild,
    });

    assert.equal(result.outcome, "escalated");
    assert.equal(sink.opened.length, 1);
    assert.equal(sink.opened[0]?.closes, 1);
  });

  it("a child over the output bound is filmed anyway, and closed once", async () => {
    const sink = recorder();
    // The bound protects this process's memory; the film is written elsewhere.
    // A child killed for saying too much is the one worth having a film of.
    const result = await runImplementer({
      invocation: baseInvocation({
        workspace: workspace(),
        maxAttempts: 1,
        gates: [{ id: "flood", argv: [node, join(fixtures, "gate-flood.mjs")], timeoutMs: 60_000 }],
      }),
      onChild: sink.onChild,
    });

    assert.equal(result.outcome, "escalated");
    const flood = sink.opened.find((child) => child.about.gate_id === "flood");
    assert.equal(flood?.closes, 1);
    assert.ok((flood?.chunks.length ?? 0) > 0, "the flood was filmed before the kill");
  });

  it("no sink is the default: a run says nothing extra and still validates", async () => {
    const result = await runImplementer({
      invocation: baseInvocation({
        workspace: workspace(),
        builderArgv: [node, join(fixtures, "builder-talks.mjs")],
      }),
    });

    assert.equal(result.outcome, "validated");
  });
});
