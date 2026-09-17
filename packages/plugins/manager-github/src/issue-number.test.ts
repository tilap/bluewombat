import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { issueNumberFromExternalId, issueNumberFromPayload } from "./issue-number.js";

describe("issueNumberFromExternalId", () => {
  it("reads the number after the last hash", () => {
    assert.equal(issueNumberFromExternalId("tilap/mason#42"), 42);
    assert.equal(issueNumberFromExternalId("github:tilap/mason#7"), 7);
    assert.equal(issueNumberFromExternalId("no-hash"), undefined);
  });
});

describe("issueNumberFromPayload", () => {
  it("reads a listing issue and a webhook envelope", () => {
    assert.equal(issueNumberFromPayload({ number: 42 }), 42);
    assert.equal(issueNumberFromPayload({ issue: { number: "9" } }), 9);
  });
});
