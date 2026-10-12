import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseBuilderFailureJson,
  parseBuilderSaid,
  parseGateVerdictJson,
} from "./parse-child-output.js";

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

describe("parseBuilderSaid", () => {
  it("reads a producer's own last words, and nothing else", () => {
    assert.equal(parseBuilderSaid('noise\n{"said":"  done and checked  "}\n'), "done and checked");
    assert.equal(parseBuilderSaid('{"said":""}'), undefined);
    assert.equal(parseBuilderSaid('{"outcome":"fail-retryable","report":"x"}'), undefined);
    assert.equal(parseBuilderSaid(""), undefined);
  });
});
