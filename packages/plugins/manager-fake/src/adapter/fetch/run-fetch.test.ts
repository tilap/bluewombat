import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFetchStdout } from "./run-fetch.js";

describe("readFetchStdout", () => {
  it("merges a JSON object", () => {
    const result = readFetchStdout('{"project":"reporting"}\n');
    assert.equal(result.kind, "merged");
    assert.deepEqual(result.kind === "merged" && result.object, { project: "reporting" });
  });

  it("treats empty stdout as nothing to merge", () => {
    assert.equal(readFetchStdout("   \n").kind, "empty");
  });

  it("treats anything else as unavailable", () => {
    for (const stdout of ["<html>", "[1,2]", '"text"', "null"]) {
      assert.equal(readFetchStdout(stdout).kind, "unavailable", stdout);
    }
  });
});
