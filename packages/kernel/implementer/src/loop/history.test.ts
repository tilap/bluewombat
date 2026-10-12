import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Trace } from "../types.js";
import { buildHistory } from "./history.js";

function trace(
  attempt: number,
  over: Partial<Trace["builder"]["result"]>,
  gates: Trace["gates"] = [],
): Trace {
  return {
    task_id: "t",
    attempt,
    builder: {
      input: { intention: "i", definition_of_done: "" },
      result: { kind: "completed", ...over },
    },
    gates,
    ended: "fail-retryable",
  };
}

describe("buildHistory", () => {
  it("has nothing to say before the first Attempt has ended", () => {
    assert.equal(buildHistory({ report: "refused", refusedBy: "ci", traces: [] }), undefined);
  });

  it("keeps the refusal the Task came with, then each Attempt, oldest first", () => {
    const history = buildHistory({
      report: "Deployment has failed",
      refusedBy: "ci-green",
      traces: [
        trace(1, { kind: "timed_out", detail: "killed after 600000ms, its own ceiling {noise}" }),
        trace(2, { kind: "completed", said: "I changed nothing" }, [
          { id: "ci-green", verdict: "fail-retryable", report: "still failing" },
        ]),
      ],
    });
    assert.ok(history !== undefined);
    const at = (text: string) => history.indexOf(text);
    assert.ok(
      at("Refused by ci-green") >= 0 && at("Deployment has failed") > at("Refused by ci-green"),
    );
    assert.ok(at("Attempt 1") > at("Deployment has failed"));
    assert.ok(at("Attempt 2") > at("Attempt 1"));
    assert.match(history, /killed at its time limit \(600000ms\)/);
    assert.match(history, /It said: I changed nothing/);
    assert.match(history, /Gate ci-green: fail-retryable\n\s+still failing/);
  });

  it("does not repeat what a killed producer wrote", () => {
    const history = buildHistory({
      report: undefined,
      refusedBy: undefined,
      traces: [
        trace(1, {
          kind: "timed_out",
          detail: "killed after 5ms, its own ceiling SPINNER SPINNER",
        }),
      ],
    });
    assert.ok(history !== undefined);
    assert.equal(history.includes("SPINNER"), false);
  });

  it("names an outside judge when no Gate refused the Task", () => {
    const history = buildHistory({
      report: "sent back",
      refusedBy: undefined,
      traces: [trace(1, { kind: "failed", outcome: "fail-retryable", detail: "boom" })],
    });
    assert.match(history ?? "", /Refused by an outside judge/);
    assert.match(history ?? "", /the producer failed \(fail-retryable\):\n\s+boom/);
  });

  it("strips terminal colours and clips a long report", () => {
    const history = buildHistory({
      report: `\u001b[31m${"x".repeat(5_000)}\u001b[0m`,
      refusedBy: "g",
      traces: [trace(1, {})],
    });
    assert.ok(history !== undefined);
    assert.equal(history.includes("\u001b"), false);
    assert.ok(history.length < 2_500);
  });

  it("leaves the oldest Attempts out when it would be too long, never the refusal or the latest", () => {
    const long = "y".repeat(700);
    const traces = Array.from({ length: 12 }, (_, i) =>
      trace(i + 1, { kind: "failed", outcome: "fail-retryable", detail: `${long}#${i + 1}` }),
    );
    const history = buildHistory({ report: "the refusal", refusedBy: "ci", traces });
    assert.ok(history !== undefined);
    assert.match(history, /the refusal/);
    assert.match(history, /#12/);
    assert.equal(history.includes("#1\n") || history.includes("#1…"), false);
    assert.match(history, /\(\d+ earlier attempts? left out\.\)/);
    assert.ok(history.length < 8_000);
  });
});
