import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { Invocation } from "../types.js";
import { runAdapter } from "./run-adapter.js";

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures");

function fixture(name: string): string[] {
  return ["node", join(fixturesDir, name)];
}

function invocation(overrides: Partial<Invocation> = {}): Invocation {
  return {
    manager: "fake",
    defaultPriority: 50,
    maxRawBytes: 10_000,
    at: "2026-09-05T10:00:00.000Z",
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

const completeRaw = JSON.stringify({
  id: "42",
  project: "reporting",
  intention: "Users need a CSV export",
});

describe("runAdapter", () => {
  it("converts a complete raw intention and ends on the result line", async () => {
    const { write, lines } = collect();
    const result = await runAdapter({ invocation: invocation(), raw: completeRaw, write });

    assert.equal(result.outcome, "converted");
    assert.equal(result.exitCode, 0);
    assert.equal(result.feature?.key, "fake:42");
    assert.equal(lines.length, 1);
    assert.equal(lines[0]?.event, "result");
    assert.equal(lines[0]?.outcome, "converted");
  });

  it("reports invalid as a verdict with exit 1, not a crash", async () => {
    const { write, lines } = collect();
    const result = await runAdapter({
      invocation: invocation(),
      raw: JSON.stringify({ id: "42", intention: "x" }),
      write,
    });

    assert.equal(result.outcome, "invalid");
    assert.equal(result.exitCode, 1);
    assert.equal(result.invalid?.code, "missing-project");
    assert.equal(lines[0]?.code, "missing-project");
    assert.equal(typeof lines[0]?.reason, "string");
  });

  it("completes a notification-shaped raw intention from the Fetch", async () => {
    const { write, lines } = collect();
    const result = await runAdapter({
      invocation: invocation({
        fetchArgv: fixture("fetch-ok.mjs"),
        fetchDurationMs: 5_000,
      }),
      raw: JSON.stringify({ id: "42" }),
      write,
    });

    assert.equal(result.outcome, "converted");
    assert.equal(result.feature?.project, "fetched-project");
    assert.equal(result.feature?.intention, "fetched intention");
    assert.equal(result.feature?.priority, 75);
    assert.equal(lines[0]?.event, "fetch-finished");
    assert.equal(lines[0]?.result, "merged");
  });

  it("lets the raw intention win over the Fetch", async () => {
    const result = await runAdapter({
      invocation: invocation({
        fetchArgv: fixture("fetch-ok.mjs"),
        fetchDurationMs: 5_000,
      }),
      raw: completeRaw,
      write: collect().write,
    });

    assert.equal(result.feature?.project, "reporting");
    assert.equal(result.feature?.intention, "Users need a CSV export");
  });

  it("passes manager, id and kind to the Fetch", async () => {
    const result = await runAdapter({
      invocation: invocation({
        fetchArgv: fixture("fetch-echo-args.mjs"),
        fetchDurationMs: 5_000,
      }),
      raw: JSON.stringify({
        id: 42,
        kind: "update",
        project: "reporting",
        intention: "x",
      }),
      write: collect().write,
    });

    assert.equal(result.feature?.title, "--manager fake --id 42 --kind update");
  });

  it("continues on a Fetch that answers with nothing", async () => {
    const { write, lines } = collect();
    const result = await runAdapter({
      invocation: invocation({
        fetchArgv: fixture("fetch-empty.mjs"),
        fetchDurationMs: 5_000,
      }),
      raw: completeRaw,
      write,
    });

    assert.equal(result.outcome, "converted");
    assert.equal(lines[0]?.result, "empty");
  });

  it("reports unavailable, not invalid, when the Fetch exits non-zero", async () => {
    const result = await runAdapter({
      invocation: invocation({
        fetchArgv: fixture("fetch-fail.mjs"),
        fetchDurationMs: 5_000,
      }),
      raw: completeRaw,
      write: collect().write,
    });

    assert.equal(result.outcome, "unavailable");
    assert.equal(result.exitCode, 3);
  });

  it("reports unavailable when the Fetch stdout is not a JSON object", async () => {
    const result = await runAdapter({
      invocation: invocation({
        fetchArgv: fixture("fetch-not-json.mjs"),
        fetchDurationMs: 5_000,
      }),
      raw: completeRaw,
      write: collect().write,
    });

    assert.equal(result.outcome, "unavailable");
  });

  it("reports unavailable when the Fetch cannot be spawned", async () => {
    const result = await runAdapter({
      invocation: invocation({
        fetchArgv: ["/nope/not-a-command"],
        fetchDurationMs: 5_000,
      }),
      raw: completeRaw,
      write: collect().write,
    });

    assert.equal(result.outcome, "unavailable");
  });

  it("kills a Fetch that runs past its clock", async () => {
    const result = await runAdapter({
      invocation: invocation({
        fetchArgv: fixture("fetch-sleep.mjs"),
        fetchDurationMs: 60,
      }),
      raw: completeRaw,
      write: collect().write,
    });

    assert.equal(result.outcome, "unavailable");
    assert.match(result.detail ?? "", /killed/);
  });

  it("skips the Fetch when the raw intention is over the ceiling", async () => {
    const { write, lines } = collect();
    const result = await runAdapter({
      invocation: invocation({
        maxRawBytes: 5,
        fetchArgv: fixture("fetch-ok.mjs"),
        fetchDurationMs: 5_000,
      }),
      raw: completeRaw,
      write,
    });

    assert.equal(result.outcome, "invalid");
    assert.equal(result.invalid?.code, "raw-too-large");
    assert.equal(
      lines.some((line) => line.event === "fetch-finished"),
      false,
    );
  });

  it("writes no partial result when interrupted", async () => {
    const { write, lines } = collect();
    const result = await runAdapter({
      invocation: invocation(),
      raw: completeRaw,
      write,
      interruptFlag: { interrupted: true },
    });

    assert.equal(result.outcome, "interrupted");
    assert.equal(result.exitCode, 130);
    assert.equal(lines[0]?.feature, undefined);
  });

  it("stamps normalized_at from --at, and the clock otherwise", async () => {
    const withAt = await runAdapter({
      invocation: invocation(),
      raw: completeRaw,
      write: collect().write,
    });
    assert.equal(withAt.feature?.normalized_at, "2026-09-05T10:00:00.000Z");

    const inv = invocation();
    delete inv.at;
    const withClock = await runAdapter({
      invocation: inv,
      raw: completeRaw,
      write: collect().write,
      now: () => Date.parse("2027-03-04T05:06:07.008Z"),
    });
    assert.equal(withClock.feature?.normalized_at, "2027-03-04T05:06:07.008Z");
  });
});
