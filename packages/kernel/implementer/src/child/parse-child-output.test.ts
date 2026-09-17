import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseBuilderFailureJson, parseGateVerdictJson } from "./parse-child-output.js";

describe("parseBuilderFailureJson", () => {
  it("reads fail-retryable and fail-blocking", () => {
    assert.deepEqual(parseBuilderFailureJson('{"outcome":"fail-retryable","report":"x"}'), {
      outcome: "fail-retryable",
      report: "x",
    });
    assert.deepEqual(parseBuilderFailureJson('noise\n{"outcome":"fail-blocking","report":"y"}\n'), {
      outcome: "fail-blocking",
      report: "y",
    });
  });

  it("rejects unknown outcome", () => {
    assert.equal(parseBuilderFailureJson('{"outcome":"pass","report":""}'), null);
  });
});

describe("parseGateVerdictJson", () => {
  it("reads known verdicts", () => {
    assert.deepEqual(parseGateVerdictJson('{"verdict":"pass"}'), {
      verdict: "pass",
      report: "",
    });
    assert.deepEqual(parseGateVerdictJson('{"verdict":"fail-retryable","report":"nope"}'), {
      verdict: "fail-retryable",
      report: "nope",
    });
  });

  it("rejects malformed stdout", () => {
    assert.equal(parseGateVerdictJson("not json"), null);
  });
});
