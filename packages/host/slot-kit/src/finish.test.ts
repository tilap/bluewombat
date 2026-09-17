import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentRun } from "./agent.js";
import { failureOf } from "./finish.js";

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
