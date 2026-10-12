import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentRun } from "./agent.js";
import { blockedReason, failureOf, judgeRun } from "./finish.js";

function ran(over: Partial<AgentRun> = {}): AgentRun {
  const startedAt = new Date(0);
  return {
    code: 1,
    signal: null,
    stdout: "",
    stderr: "",
    output: "",
    startedAt,
    endedAt: startedAt,
    durationMs: 0,
    ...over,
  };
}

describe("failureOf", () => {
  it("blocks when the CLI never started, and says where it looked", () => {
    const failure = failureOf(ran({ error: new Error("ENOENT") }), "/bin/claude", "Claude Code");
    assert.equal(failure.outcome, "fail-blocking");
    assert.equal(failure.report, "Could not start Claude Code at /bin/claude: ENOENT");
  });

  it("retries when the agent failed at the work", () => {
    const failure = failureOf(ran({ output: "the tests are still red" }), "/bin/x", "Cursor CLI");
    assert.equal(failure.outcome, "fail-retryable");
    assert.equal(failure.report, "the tests are still red");
  });

  it("blocks on a CLI that is not usable as invoked", () => {
    for (const output of [
      "Error: not logged in",
      "authentication failed",
      "invalid api key",
      "Your credit balance is too low",
      "error: unknown option '--sandbox'",
      "unknown model: opus-9",
    ]) {
      assert.equal(failureOf(ran({ output }), "/bin/x", "CLI").outcome, "fail-blocking", output);
    }
  });

  it("prefers the CLI's own result object to the raw output", () => {
    const run = ran({
      stdout: '{"is_error":true,"error":"rate limited"}\n',
      output: 'noise\n{"is_error":true,"error":"rate limited"}\n',
    });
    assert.equal(failureOf(run, "/bin/x", "CLI").report, "rate limited");
  });

  it("reads the result fields in order: error, then message, then result", () => {
    const run = ran({ stdout: '{"message":"m","result":"r"}' });
    assert.equal(failureOf(run, "/bin/x", "CLI").report, "m");
  });

  it("names the signal when a killed run said nothing", () => {
    const failure = failureOf(ran({ code: null, signal: "SIGKILL" }), "/bin/x", "CLI");
    assert.equal(failure.report, "CLI was killed by SIGKILL.");
  });

  it("names the exit code when a silent run just ended", () => {
    assert.equal(
      failureOf(ran({ code: 3 }), "/bin/x", "CLI").report,
      "CLI exited 3 without output.",
    );
  });

  it("keeps the tail of a long report", () => {
    const report = failureOf(ran({ output: `${"x".repeat(3000)}END` }), "/bin/x", "CLI").report;
    assert.equal(report.length, 2000);
    assert.ok(report.endsWith("END"));
  });
});

function said(text: string): AgentRun {
  return ran({ code: 0, stdout: `${JSON.stringify({ type: "result", result: text })}\n` });
}

describe("blockedReason", () => {
  it("reads the last MASON_BLOCKED line of a final message", () => {
    assert.equal(
      blockedReason("I looked.\nMASON_BLOCKED: the report is only a link"),
      "the report is only a link",
    );
    assert.equal(blockedReason("MASON_BLOCKED: first\nthen more\nMASON_BLOCKED: last"), "last");
  });

  it("is absent when the agent did not say it, or said it mid-sentence", () => {
    assert.equal(blockedReason("All done."), undefined);
    assert.equal(blockedReason("I will not write MASON_BLOCKED: here"), undefined);
    assert.equal(blockedReason(""), undefined);
  });

  it("still blocks when the agent gave no reason", () => {
    assert.equal(blockedReason("MASON_BLOCKED:"), "it did not say what is missing");
  });
});

describe("judgeRun", () => {
  it("is done on a clean exit, and keeps what the agent said", () => {
    assert.deepEqual(judgeRun(said("Added the tabs."), "/bin/x", "CLI"), {
      done: true,
      said: "Added the tabs.",
    });
  });

  it("is blocked, not retryable, when the agent says it cannot act", () => {
    const judged = judgeRun(
      said("Nothing to fix here.\nMASON_BLOCKED: no log to read"),
      "/bin/x",
      "CLI",
    );
    assert.deepEqual(judged, {
      done: false,
      outcome: "fail-blocking",
      report: "The agent stopped without changing anything: no log to read",
    });
  });

  it("keeps failing as before when the run itself failed", () => {
    const judged = judgeRun(ran({ output: "the tests are still red" }), "/bin/x", "CLI");
    assert.deepEqual(judged, {
      done: false,
      outcome: "fail-retryable",
      report: "the tests are still red",
    });
  });

  it("does not trust a blocked line in a run that errored", () => {
    const run = ran({
      code: 0,
      stdout: `${JSON.stringify({ is_error: true, error: "rate limited", result: "MASON_BLOCKED: x" })}\n`,
    });
    assert.deepEqual(judgeRun(run, "/bin/x", "CLI"), {
      done: false,
      outcome: "fail-retryable",
      report: "rate limited",
    });
  });
});
