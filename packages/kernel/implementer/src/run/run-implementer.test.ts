import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { Invocation } from "../types.js";
import { runImplementer } from "./run-implementer.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures");
const node = process.execPath;

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "implementer-run-"));
}

function baseInvocation(over: Partial<Invocation> & Pick<Invocation, "workspace">): Invocation {
  return {
    id: "task-1",
    intention: "ship it",
    definitionOfDone: "green",
    builderArgv: [node, join(fixtures, "builder-ok.mjs")],
    gates: [],
    maxAttempts: 3,
    builderTimeoutMs: 10_000,
    ...over,
  };
}

function collectLines(): {
  write: (line: Record<string, unknown>) => void;
  lines: Record<string, unknown>[];
} {
  const lines: Record<string, unknown>[] = [];
  return {
    lines,
    write: (line) => {
      lines.push(line);
    },
  };
}

describe("runImplementer acceptance", () => {
  it("00. a Gate that never stops writing is a broken Gate, and the process survives", async () => {
    const { write, lines } = collectLines();
    const result = await runImplementer({
      invocation: baseInvocation({
        workspace: workspace(),
        maxAttempts: 1,
        gates: [{ id: "flood", argv: [node, join(fixtures, "gate-flood.mjs")], timeoutMs: 60_000 }],
      }),
      write,
    });
    const gate = lines.find((line) => line.event === "gate-finished");
    assert.equal(gate?.verdict, "fail-blocking");
    assert.match(String(gate?.report), /wrote more than/);
    assert.equal(result.outcome, "escalated");
  });

  it("0. a Gate's verdict is read whole, however long its report", async () => {
    const { write, lines } = collectLines();
    const result = await runImplementer({
      invocation: baseInvocation({
        workspace: workspace(),
        maxAttempts: 1,
        gates: [
          { id: "ci", argv: [node, join(fixtures, "gate-fail-long-report.mjs")], timeoutMs: 5_000 },
        ],
      }),
      write,
    });
    const gate = lines.find((line) => line.event === "gate-finished");
    assert.equal(gate?.verdict, "fail-retryable");
    assert.match(String(gate?.report), /Object\.groupBy is not a function$/);
    assert.equal(result.outcome, "escalated");
  });

  it("1. no Gate, Builder exits 0 → validated after Attempt 1", async () => {
    const { write, lines } = collectLines();
    const result = await runImplementer({
      invocation: baseInvocation({ workspace: workspace() }),
      write,
    });
    assert.equal(result.outcome, "validated");
    assert.equal(result.exitCode, 0);
    assert.equal(result.traces.length, 1);
    assert.equal(result.traces[0]?.ended, "validated");
    const statuses = lines.filter((l) => l.event === "status");
    assert.ok(statuses.some((s) => s.label === "building:attempt-1:3"));
    assert.ok(statuses.some((s) => s.label === "validated:attempt-1:3"));
  });

  it("2. fail-retryable Gate → new Attempt; Builder receives --report", async () => {
    const result = await runImplementer({
      invocation: baseInvocation({
        workspace: workspace(),
        builderArgv: [node, join(fixtures, "builder-ok-with-report-on-retry.mjs")],
        gates: [
          { id: "lint", argv: [node, join(fixtures, "gate-fail-once.mjs")], timeoutMs: 5_000 },
        ],
      }),
      write: () => {},
    });
    assert.equal(result.outcome, "validated");
    assert.equal(result.traces.length, 2);
    assert.equal(result.traces[0]?.ended, "fail-retryable");
    assert.equal(result.traces[1]?.builder.input.report, "lint failed");
  });

  it("2b. a Task that says what it belongs to passes that to its Builder", async () => {
    const ws = workspace();
    const result = await runImplementer({
      invocation: {
        ...baseInvocation({
          workspace: ws,
          builderArgv: [node, join(fixtures, "builder-echo-argv.mjs")],
          gates: [],
        }),
        context: "github:tilap/mason-one#34",
      },
      write: () => {},
    });
    assert.equal(result.outcome, "validated");
    const argv = JSON.parse(readFileSync(join(ws, "argv.json"), "utf8")) as string[];
    assert.deepEqual(argv.slice(-2), ["--context", "github:tilap/mason-one#34"]);
  });

  it("2c. a Task tells its Gates which situation they are judging", async () => {
    const ws = workspace();
    const result = await runImplementer({
      invocation: {
        ...baseInvocation({
          workspace: ws,
          gates: [
            { id: "echo", argv: [node, join(fixtures, "gate-echo-argv.mjs")], timeoutMs: 5_000 },
          ],
        }),
        stage: "assembly",
      },
      write: () => {},
    });
    assert.equal(result.outcome, "validated");
    const argv = JSON.parse(readFileSync(join(ws, "gate-argv.json"), "utf8")) as string[];
    assert.deepEqual(argv.slice(-2), ["--stage", "assembly"]);
  });

  it("3. a Gate that passed on Attempt 1 runs again on Attempt 2", async () => {
    const ws = workspace();
    const track = join(fixtures, "gate-track-and-retry.mjs");
    const result = await runImplementer({
      invocation: baseInvocation({
        workspace: ws,
        gates: [
          { id: "first", argv: [node, track], timeoutMs: 5_000 },
          { id: "second", argv: [node, track], timeoutMs: 5_000 },
        ],
      }),
      write: () => {},
    });
    assert.equal(result.outcome, "validated");
    assert.equal(result.traces.length, 2);
    const marker = readFileSync(join(ws, "gate-runs.txt"), "utf8").trim().split("\n");
    assert.deepEqual(marker, ["first:1", "second:1", "first:2", "second:2"]);
  });

  it("4. fail-blocking → escalated, no further Attempt, with a Trace", async () => {
    const result = await runImplementer({
      invocation: baseInvocation({
        workspace: workspace(),
        gates: [
          { id: "sec", argv: [node, join(fixtures, "gate-fail-blocking.mjs")], timeoutMs: 5_000 },
        ],
        maxAttempts: 5,
      }),
      write: () => {},
    });
    assert.equal(result.outcome, "escalated");
    assert.equal(result.traces.length, 1);
    assert.equal(result.traces[0]?.ended, "fail-blocking");
  });

  it("5. max-attempts exhausted on retryable failure → escalated with Trace", async () => {
    const result = await runImplementer({
      invocation: baseInvocation({
        workspace: workspace(),
        gates: [
          { id: "lint", argv: [node, join(fixtures, "gate-fail-retryable.mjs")], timeoutMs: 5_000 },
        ],
        maxAttempts: 2,
      }),
      write: () => {},
    });
    assert.equal(result.outcome, "escalated");
    assert.equal(result.traces.length, 2);
    assert.ok(result.traces.every((t) => t.ended === "fail-retryable"));
  });

  it("6. interrupt during Builder → interrupted; workspace still on disk", async () => {
    const ws = workspace();
    const marker = join(ws, "keep-me.txt");
    writeFileSync(marker, "present");
    const flag = { interrupted: false };
    const pending = runImplementer({
      invocation: baseInvocation({
        workspace: ws,
        builderArgv: [node, join(fixtures, "sleep.mjs"), "30000"],
        builderTimeoutMs: 60_000,
      }),
      write: () => {},
      interruptFlag: flag,
    });
    await new Promise((r) => setTimeout(r, 80));
    flag.interrupted = true;
    const result = await pending;
    assert.equal(result.outcome, "interrupted");
    assert.equal(result.exitCode, 130);
    assert.ok(existsSync(marker), "workspace must not be deleted");
  });

  it("7. never deletes workspace; empty Gate list is allowed", async () => {
    const ws = workspace();
    const marker = join(ws, "artifact.txt");
    writeFileSync(marker, "x");
    const result = await runImplementer({
      invocation: baseInvocation({ workspace: ws, gates: [] }),
      write: () => {},
    });
    assert.equal(result.outcome, "validated");
    assert.ok(existsSync(marker));
  });

  it("9. building:attempt-1:3 on stdout and via --on-status", async () => {
    const ws = workspace();
    const statusLog = join(ws, "status.log");
    process.env.ON_STATUS_LOG = statusLog;
    try {
      const { write, lines } = collectLines();
      const result = await runImplementer({
        invocation: baseInvocation({
          workspace: ws,
          onStatusArgv: [node, join(fixtures, "on-status-log.mjs")],
        }),
        write,
      });
      assert.equal(result.outcome, "validated");
      assert.ok(lines.some((l) => l.event === "status" && l.label === "building:attempt-1:3"));
      const logged = readFileSync(statusLog, "utf8");
      assert.ok(logged.includes("building:attempt-1:3"));
    } finally {
      delete process.env.ON_STATUS_LOG;
    }
  });

  it("10. --on-status exiting non-zero does not change a validated run", async () => {
    const result = await runImplementer({
      invocation: baseInvocation({
        workspace: workspace(),
        onStatusArgv: [node, join(fixtures, "on-status-fail.mjs")],
      }),
      write: () => {},
    });
    assert.equal(result.outcome, "validated");
  });

  it("Builder fail-blocking escalates with a Trace", async () => {
    const result = await runImplementer({
      invocation: baseInvocation({
        workspace: workspace(),
        builderArgv: [node, join(fixtures, "builder-fail-blocking.mjs")],
        maxAttempts: 3,
      }),
      write: () => {},
    });
    assert.equal(result.outcome, "escalated");
    assert.equal(result.traces.length, 1);
    assert.equal(result.traces[0]?.ended, "fail-blocking");
  });

  it("a producer over its own ceiling is fail-retryable, then escalates with no Attempts left", async () => {
    const result = await runImplementer({
      invocation: baseInvocation({
        workspace: workspace(),
        builderArgv: [node, join(fixtures, "sleep.mjs"), "5000"],
        maxAttempts: 1,
        builderTimeoutMs: 50,
      }),
      write: () => {},
    });
    assert.equal(result.outcome, "escalated");
    assert.equal(result.traces[0]?.ended, "fail-retryable");
    assert.equal(result.traces[0]?.builder.result.kind, "timed_out");
    assert.match(result.traces[0]?.builder.result.detail ?? "", /killed after 50ms/);
  });

  it("holds a Gate to its own ceiling", async () => {
    const ws = workspace();
    const started = Date.now();
    const result = await runImplementer({
      invocation: baseInvocation({
        workspace: ws,
        maxAttempts: 1,
        builderTimeoutMs: 30_000,
        gates: [
          { id: "slow", argv: [node, join(fixtures, "gate-slow.mjs")], timeoutMs: 700 },
          { id: "after", argv: [node, join(fixtures, "gate-pass.mjs")], timeoutMs: 5_000 },
        ],
      }),
      write: () => {},
    });
    // The slow Gate is held to its own 700ms and nothing else waits it out.
    assert.equal(result.outcome, "escalated");
    assert.ok(Date.now() - started < 10_000, "a Gate must not outlive its own ceiling");
  });

  it("hands a pass with something to resolve to the repair producer", async () => {
    // Making from a specification and repairing what a check refused are two
    // jobs. Attempt 1 makes; the Gate refuses; Attempt 2 repairs.
    const ws = workspace();
    const mark = join(fixtures, "builder-mark.mjs");
    const result = await runImplementer({
      invocation: baseInvocation({
        workspace: ws,
        builderArgv: [node, mark, "build"],
        repairArgv: [node, mark, "repair"],
        maxAttempts: 2,
        gates: [
          { id: "once", argv: [node, join(fixtures, "gate-fail-once.mjs")], timeoutMs: 5_000 },
        ],
      }),
      write: () => {},
    });
    assert.equal(result.outcome, "validated");
    assert.deepEqual(readFileSync(join(ws, "producers.txt"), "utf8").trim().split("\n"), [
      "build",
      "repair",
    ]);
  });

  it("repairs from its very first Attempt when the report came from outside", async () => {
    // A Task run again because an outside judge sent its result back carries a
    // report before any Attempt of this invocation has run. The producer chosen
    // must follow the report, not the Attempt number.
    const ws = workspace();
    const mark = join(fixtures, "builder-mark.mjs");
    const result = await runImplementer({
      invocation: baseInvocation({
        workspace: ws,
        builderArgv: [node, mark, "build"],
        repairArgv: [node, mark, "repair"],
        report: "the Authority sent it back",
        maxAttempts: 1,
      }),
      write: () => {},
    });
    assert.equal(result.outcome, "validated");
    assert.equal(readFileSync(join(ws, "producers.txt"), "utf8").trim(), "repair");
  });

  it("falls back to the one producer when no repair command was given", async () => {
    const ws = workspace();
    const result = await runImplementer({
      invocation: baseInvocation({
        workspace: ws,
        builderArgv: [node, join(fixtures, "builder-mark.mjs"), "build"],
        report: "something refused it",
        maxAttempts: 1,
      }),
      write: () => {},
    });
    assert.equal(result.outcome, "validated");
    assert.equal(readFileSync(join(ws, "producers.txt"), "utf8").trim(), "build");
  });

  it("holds the repair producer to its own ceiling", async () => {
    const result = await runImplementer({
      invocation: baseInvocation({
        workspace: workspace(),
        builderArgv: [node, join(fixtures, "builder-ok.mjs")],
        repairArgv: [node, join(fixtures, "sleep.mjs"), "5000"],
        report: "resolve this",
        builderTimeoutMs: 30_000,
        repairTimeoutMs: 50,
        maxAttempts: 1,
      }),
      write: () => {},
    });
    assert.equal(result.traces[0]?.builder.result.kind, "timed_out");
    assert.match(result.traces[0]?.builder.result.detail ?? "", /killed after 50ms/);
  });

  it("runs a Task that has no producer as its Gate sequence alone", async () => {
    const ws = workspace();
    const invocation = baseInvocation({
      workspace: ws,
      gates: [{ id: "check", argv: [node, join(fixtures, "gate-pass.mjs")], timeoutMs: 5_000 }],
    });
    delete (invocation as { builderArgv?: string[] }).builderArgv;
    const { write, lines } = collectLines();
    const result = await runImplementer({ invocation, write });
    assert.equal(result.outcome, "validated");
    assert.equal(
      lines.some((line) => line.event === "builder-finished"),
      false,
      "nothing was produced, so nothing is announced as produced",
    );
  });
});
