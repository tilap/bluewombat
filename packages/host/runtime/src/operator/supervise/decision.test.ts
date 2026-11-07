import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { lastJson, parseDecision } from "./decision.js";

const good = {
  summary: "two tickets made the same migration",
  cause: "no Blocked by between #32 and #34, and a resume ignores maxParallel",
  evidence: ["open-work-ledger.js:475 resumeTicket does not count maxParallel"],
  confidence: "high",
  unblockAfterFixes: true,
  unblock: [{ do: "resume", key: "github:o/r#34", reason: "after the fix" }],
  fixes: [
    {
      target: "mason",
      title: "resume respects maxParallel",
      instruction: "In resumeTicket, refuse when the project is busy, and add a test for it.",
      conformity: "DECISIONS row 12: resume keeps its budget; this touches neither",
    },
  ],
};

const fence = (value: unknown) => `Reasoning here.\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`\n`;

describe("lastJson", () => {
  it("takes the last fenced block", () => {
    assert.deepEqual(lastJson(`${fence({ a: 1 })}\nand then\n${fence({ a: 2 })}`), { a: 2 });
  });
  it("falls back to the last balanced braces", () => {
    assert.deepEqual(lastJson('so: {"a": {"b": 1}} done'), { a: { b: 1 } });
  });
  it("returns nothing when there is nothing", () => {
    assert.equal(lastJson("no json at all"), undefined);
  });
});

describe("parseDecision", () => {
  it("accepts a complete decision", () => {
    const parsed = parseDecision(fence(good), ["mason"]);
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.decision.fixes[0]?.target, "mason");
      assert.equal(parsed.decision.unblockAfterFixes, true);
    }
  });

  it("refuses a fix aimed at a repository nobody gave", () => {
    const parsed = parseDecision(fence(good), ["other"]);
    assert.equal(parsed.ok, false);
    assert.match(parsed.ok ? "" : parsed.reason, /fix\.target/);
  });

  it("refuses a decision with no evidence", () => {
    const parsed = parseDecision(fence({ ...good, evidence: [] }), ["mason"]);
    assert.equal(parsed.ok, false);
    assert.match(parsed.ok ? "" : parsed.reason, /evidence/);
  });

  it("refuses a resume with no key", () => {
    const parsed = parseDecision(fence({ ...good, unblock: [{ do: "resume", reason: "x" }] }), [
      "mason",
    ]);
    assert.equal(parsed.ok, false);
  });

  it("refuses a move that does not exist", () => {
    const parsed = parseDecision(
      fence({ ...good, unblock: [{ do: "raise-limit", reason: "x" }] }),
      ["mason"],
    );
    assert.equal(parsed.ok, false);
    assert.match(parsed.ok ? "" : parsed.reason, /raise-limit/);
  });

  it("refuses a fix whose instruction a stranger could not carry out", () => {
    const parsed = parseDecision(
      fence({ ...good, fixes: [{ target: "mason", title: "t", instruction: "fix it" }] }),
      ["mason"],
    );
    assert.equal(parsed.ok, false);
  });

  it("refuses a stop for a person that also resumes", () => {
    const parsed = parseDecision(fence({ ...good, needsHuman: "a credential" }), ["mason"]);
    assert.equal(parsed.ok, false);
    assert.match(parsed.ok ? "" : parsed.reason, /contradict/);
  });

  it("refuses to wait for fixes before unblocking nothing", () => {
    const parsed = parseDecision(fence({ ...good, unblock: [] }), ["mason"]);
    assert.equal(parsed.ok, false);
    assert.match(parsed.ok ? "" : parsed.reason, /nothing to unblock/);
  });

  it("refuses a fix that does not say which rules it touches", () => {
    const { conformity: _gone, ...bare } = good.fixes[0] as Record<string, unknown>;
    const parsed = parseDecision(fence({ ...good, fixes: [bare] }), ["mason"]);
    assert.equal(parsed.ok, false);
    assert.match(parsed.ok ? "" : parsed.reason, /conformity/);
  });

  it("turns a fix that revises a decision into a stop for a person", () => {
    const fix = { ...good.fixes[0], revises: "DECISIONS row 64 (explicit gate)" };
    const parsed = parseDecision(
      fence({ ...good, unblock: [], unblockAfterFixes: false, fixes: [fix] }),
      ["mason"],
    );
    assert.ok(parsed.ok);
    assert.match(parsed.ok ? (parsed.decision.needsHuman ?? "") : "", /row 64/);
  });
});
