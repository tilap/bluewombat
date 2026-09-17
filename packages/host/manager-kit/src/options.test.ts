import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  booleanOption,
  intOption,
  rejectUnknownOptions,
  stringArrayOption,
  stringOption,
} from "./options.js";

describe("stringOption", () => {
  it("accepts a non-empty string and refuses anything else", () => {
    assert.deepEqual(stringOption({ repo: "a/b" }, "repo"), { ok: true, value: "a/b" });
    assert.deepEqual(stringOption({}, "repo"), { ok: true, value: undefined });
    assert.equal(stringOption({ repo: "  " }, "repo").ok, false);
    assert.equal(stringOption({ repo: 3 }, "repo").ok, false);
  });
});

describe("stringArrayOption", () => {
  it("wraps the single-flag spelling and keeps the JSON array", () => {
    assert.deepEqual(stringArrayOption({ labels: "mason" }, "labels"), {
      ok: true,
      value: ["mason"],
    });
    assert.deepEqual(stringArrayOption({ labels: ["a", "b"] }, "labels"), {
      ok: true,
      value: ["a", "b"],
    });
    assert.equal(stringArrayOption({ labels: [1] }, "labels").ok, false);
  });
});

describe("intOption", () => {
  it("reads a number or its string spelling, inside the bounds", () => {
    assert.deepEqual(intOption({ priority: 50 }, "priority", 0, 100), { ok: true, value: 50 });
    assert.deepEqual(intOption({ priority: "50" }, "priority", 0, 100), { ok: true, value: 50 });
    assert.equal(intOption({ priority: "101" }, "priority", 0, 100).ok, false);
    assert.equal(intOption({ priority: "x" }, "priority", 0, 100).ok, false);
  });
});

describe("booleanOption", () => {
  it("reads a boolean or its string spelling", () => {
    assert.deepEqual(booleanOption({ dry: true }, "dry"), { ok: true, value: true });
    assert.deepEqual(booleanOption({ dry: "false" }, "dry"), { ok: true, value: false });
    assert.equal(booleanOption({ dry: "yes" }, "dry").ok, false);
  });
});

describe("rejectUnknownOptions", () => {
  it("names the unknown key and lists what is known", () => {
    assert.deepEqual(rejectUnknownOptions({ repo: "a/b" }, ["repo"]), { ok: true });
    const refused = rejectUnknownOptions({ repos: "a/b" }, ["repo", "labels"]);
    assert.equal(refused.ok, false);
    assert.match(refused.ok === false ? refused.reason : "", /unknown key "repos".*labels, repo/);
  });
});
