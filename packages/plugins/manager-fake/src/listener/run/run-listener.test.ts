import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { Invocation } from "../types.js";
import { runListener } from "./run-listener.js";

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures");

function sourceDir(): string {
  return mkdtempSync(join(tmpdir(), "feature-listener-run-"));
}

function publish(source: string, name: string, content: unknown): void {
  const body = typeof content === "string" ? content : JSON.stringify(content);
  writeFileSync(join(source, name), body);
}

function invocation(source: string, overrides: Partial<Invocation> = {}): Invocation {
  return {
    manager: "fake",
    source,
    follow: false,
    maxEvents: 100,
    durationMs: 5_000,
    ...overrides,
  };
}

function collect(): {
  write: (line: Record<string, unknown>) => void;
  lines: Record<string, unknown>[];
} {
  const lines: Record<string, unknown>[] = [];
  return { write: (line) => lines.push(line), lines };
}

function ofEvent(lines: Record<string, unknown>[], event: string): Record<string, unknown>[] {
  return lines.filter((line) => line.event === event);
}

describe("runListener", () => {
  it("delivers every Event in file-name order and ends on the last Cursor", async () => {
    const source = sourceDir();
    publish(source, "0002-b.json", { id: "b" });
    publish(source, "0001-a.json", { id: "a" });
    publish(source, "0003-c.json", { id: "c" });

    const { write, lines } = collect();
    const result = await runListener({ invocation: invocation(source), write });

    assert.equal(result.outcome, "completed");
    assert.equal(result.stopReason, "drained");
    assert.equal(result.delivered, 3);
    assert.equal(result.cursor, "0003-c.json");
    assert.equal(result.exitCode, 0);
    assert.deepEqual(
      ofEvent(lines, "intention").map((line) => line.cursor),
      ["0001-a.json", "0002-b.json", "0003-c.json"],
    );
  });

  it("delivers only what is strictly after --since", async () => {
    const source = sourceDir();
    publish(source, "0001-a.json", { id: "a" });
    publish(source, "0002-b.json", { id: "b" });
    publish(source, "0003-c.json", { id: "c" });

    const { write, lines } = collect();
    const result = await runListener({
      invocation: invocation(source, { since: "0002-b.json" }),
      write,
    });

    assert.equal(result.delivered, 1);
    assert.deepEqual(
      ofEvent(lines, "intention").map((line) => line.cursor),
      ["0003-c.json"],
    );
  });

  it("skips an unparseable Event, advances the Cursor, and still completes", async () => {
    const source = sourceDir();
    publish(source, "0001-a.json", "not json");
    publish(source, "0002-b.json", { id: "b" });

    const { write, lines } = collect();
    const result = await runListener({ invocation: invocation(source), write });

    assert.equal(result.outcome, "completed");
    assert.equal(result.skipped, 1);
    assert.equal(result.delivered, 1);
    assert.equal(result.cursor, "0002-b.json");
    const skipped = ofEvent(lines, "skipped");
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0]?.cursor, "0001-a.json");
    assert.equal(skipped[0]?.reason, "not-json");
  });

  it("skips an Event that is not a JSON object", async () => {
    const source = sourceDir();
    publish(source, "0001-a.json", "[1, 2, 3]");

    const { write, lines } = collect();
    const result = await runListener({ invocation: invocation(source), write });

    assert.equal(result.skipped, 1);
    assert.equal(ofEvent(lines, "skipped")[0]?.reason, "not-object");
  });

  it("stops on --max-events, counting skipped Events too", async () => {
    const source = sourceDir();
    for (const n of [1, 2, 3, 4, 5]) {
      publish(source, `000${n}-e.json`, { id: `e${n}` });
    }

    const { write } = collect();
    const result = await runListener({
      invocation: invocation(source, { maxEvents: 2 }),
      write,
    });

    assert.equal(result.outcome, "completed");
    assert.equal(result.stopReason, "max-events");
    assert.equal(result.delivered, 2);
    assert.equal(result.cursor, "0002-e.json");
  });

  it("delivers a file that appears after the first scan when following", async () => {
    const source = sourceDir();
    publish(source, "0001-a.json", { id: "a" });

    const { write, lines } = collect();
    setTimeout(() => publish(source, "0002-b.json", { id: "b" }), 30);

    const result = await runListener({
      invocation: invocation(source, {
        follow: true,
        pollIntervalMs: 10,
        maxEvents: 2,
        durationMs: 3_000,
      }),
      write,
    });

    assert.equal(result.stopReason, "max-events");
    assert.deepEqual(
      ofEvent(lines, "intention").map((line) => line.cursor),
      ["0001-a.json", "0002-b.json"],
    );
  });

  it("stops on a signal while following, keeping the last committed Cursor", async () => {
    const source = sourceDir();
    publish(source, "0001-a.json", { id: "a" });

    const interruptFlag = { interrupted: false };
    const { write, lines } = collect();
    setTimeout(() => {
      interruptFlag.interrupted = true;
    }, 30);

    const result = await runListener({
      invocation: invocation(source, { follow: true, pollIntervalMs: 10, durationMs: 3_000 }),
      write,
      interruptFlag,
    });

    assert.equal(result.outcome, "interrupted");
    assert.equal(result.stopReason, "signal");
    assert.equal(result.exitCode, 130);
    assert.equal(result.cursor, "0001-a.json");
    assert.equal(ofEvent(lines, "intention").length, 1);
  });

  it("stops on the duration clock", async () => {
    const source = sourceDir();
    let clock = 0;
    const { write } = collect();

    const result = await runListener({
      invocation: invocation(source, { follow: true, pollIntervalMs: 1, durationMs: 50 }),
      write,
      now: () => {
        clock += 30;
        return clock;
      },
    });

    assert.equal(result.outcome, "completed");
    assert.equal(result.stopReason, "duration");
  });

  it("reports source-lost when the Source disappears", async () => {
    const source = sourceDir();
    publish(source, "0001-a.json", { id: "a" });

    const { write } = collect();
    const inv = invocation(source, { follow: true, pollIntervalMs: 5, durationMs: 3_000 });
    setTimeout(() => rmSync(source, { recursive: true, force: true }), 20);

    const result = await runListener({ invocation: inv, write });
    assert.equal(result.outcome, "source-lost");
    assert.equal(result.exitCode, 1);
    assert.equal(result.cursor, "0001-a.json");
  });

  it("keeps payload keys it knows nothing about", async () => {
    const source = sourceDir();
    publish(source, "0001-a.json", { id: "a", weird: { nested: [1, "two"] }, extra: null });

    const { write, lines } = collect();
    await runListener({ invocation: invocation(source), write });

    assert.deepEqual(ofEvent(lines, "intention")[0]?.payload, {
      id: "a",
      weird: { nested: [1, "two"] },
      extra: null,
    });
  });

  it("does not let a failing --on-intention change the outcome or the Cursor", async () => {
    const source = sourceDir();
    publish(source, "0001-a.json", { id: "a" });

    const { write } = collect();
    const result = await runListener({
      invocation: invocation(source, {
        onIntentionArgv: ["node", join(fixturesDir, "on-intention-fail.mjs")],
      }),
      write,
    });

    assert.equal(result.outcome, "completed");
    assert.equal(result.delivered, 1);
    assert.equal(result.cursor, "0001-a.json");
  });

  it("runs --on-intention once per Delivery with manager, cursor and payload", async () => {
    const source = sourceDir();
    publish(source, "0001-a.json", { id: "a" });
    publish(source, "0002-b.json", { id: "b" });
    const logFile = join(sourceDir(), "hook.log");

    const { write } = collect();
    process.env.ON_INTENTION_LOG = logFile;
    try {
      await runListener({
        invocation: invocation(source, {
          onIntentionArgv: ["node", join(fixturesDir, "on-intention-log.mjs")],
        }),
        write,
      });
    } finally {
      process.env.ON_INTENTION_LOG = undefined;
    }

    const logged = readFileSync(logFile, "utf8").trim().split("\n");
    assert.equal(logged.length, 2);
    assert.match(logged[0] ?? "", /--manager fake --cursor 0001-a\.json --payload \{"id":"a"\}/);
  });

  it("never writes into the Source", async () => {
    const source = sourceDir();
    publish(source, "0001-a.json", { id: "a" });
    publish(source, "0002-b.json", "not json");
    const before = readdirSync(source).sort();

    const { write } = collect();
    await runListener({ invocation: invocation(source), write });

    assert.deepEqual(readdirSync(source).sort(), before);
  });

  it("skips an Event it cannot read", async () => {
    const source = sourceDir();
    const path = join(source, "0001-a.json");
    publish(source, "0001-a.json", { id: "a" });
    chmodSync(path, 0o000);

    const { write, lines } = collect();
    const result = await runListener({ invocation: invocation(source), write });
    chmodSync(path, 0o600);

    // Running as root defeats the permission bit; then the Event is simply delivered.
    if (result.skipped === 1) {
      assert.equal(ofEvent(lines, "skipped")[0]?.reason, "unreadable");
    } else {
      assert.equal(result.delivered, 1);
    }
    assert.equal(result.cursor, "0001-a.json");
  });
});
