import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { arbiterPrompt, type Brief, fixerPrompt, rootcausePrompt } from "./prompts.js";

const brief: Brief = {
  finding: { kind: "escalated", scope: "ticket", key: "k#1", detail: "d" } as Brief["finding"],
  ledgerRoot: "/ledger",
  codeRoots: ["/repo"],
  targets: ["mason"],
  rules: ["/repo/AGENTS.md"],
  history: [],
};

describe("prompts", () => {
  it("sends every member to the rules before it reasons", () => {
    for (const prompt of [rootcausePrompt(brief), arbiterPrompt(brief, {})]) {
      assert.match(prompt, /## The rules\nRead these before anything else/);
      assert.match(prompt, /\/repo\/AGENTS\.md/);
    }
  });

  it("does not tell the members to ignore the documents", () => {
    assert.doesNotMatch(rootcausePrompt(brief), /Not documentation/);
  });

  it("asks the arbiter for a result and a conformity, not a design", () => {
    const prompt = arbiterPrompt(brief, {});
    assert.match(prompt, /does not state the design/);
    assert.match(prompt, /"conformity"/);
    assert.match(prompt, /"revises"/);
  });

  it("makes the repository's rules win over the instruction", () => {
    const prompt = fixerPrompt({
      target: "mason",
      title: "t",
      instruction: "i",
      conformity: "c",
      cause: "x",
      evidence: [],
      deny: [],
      checks: [],
    });
    assert.match(prompt, /rules,\s+which win over this instruction/);
  });
});
