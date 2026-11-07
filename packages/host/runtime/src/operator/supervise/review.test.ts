import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseVerdict } from "./review.js";

const fence = (value: unknown) => `notes\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

describe("parseVerdict", () => {
  it("accepts an approval that shows what it checked", () => {
    const v = parseVerdict(fence({ verdict: "approve", checked: ["a.ts:1 → ok"], findings: [] }));
    assert.deepEqual(v, { ok: true, approve: true, checked: ["a.ts:1 → ok"], deferred: [] });
  });
  it("does not take an approval that checked nothing", () => {
    assert.equal(parseVerdict(fence({ verdict: "approve", checked: [] })).ok, false);
  });
  it("turns an approval with something unverified into a rejection", () => {
    const v = parseVerdict(fence({ verdict: "approve", checked: ["x"], unverified: ["the CLI"] }));
    assert.equal(v.ok && !v.approve, true);
  });
  it("turns an approval carrying findings into a rejection", () => {
    const v = parseVerdict(
      fence({ verdict: "approve", checked: ["x"], findings: [{ point: 3, problem: "p" }] }),
    );
    assert.equal(v.ok && !v.approve, true);
  });
  it("keeps the reasons of a rejection", () => {
    const v = parseVerdict(
      fence({
        verdict: "reject",
        findings: [{ point: 2, problem: "a caller breaks", evidence: "b.ts:9" }],
      }),
    );
    assert.equal(v.ok && !v.approve && /a caller breaks/.test(v.reasons[0] ?? ""), true);
  });
  it("refuses an answer with no verdict", () => {
    assert.equal(parseVerdict("fine by me").ok, false);
  });

  it("hands back the numbers of the points that were rejected", () => {
    const answer = `\`\`\`json\n${JSON.stringify({
      verdict: "reject",
      findings: [
        { point: 3, problem: "p", evidence: "e", required: "r" },
        { point: 5, problem: "p", evidence: "e", required: "r" },
      ],
    })}\n\`\`\``;
    const v = parseVerdict(answer);
    assert.deepEqual(v.ok && !v.approve ? v.points : undefined, [3, 5]);
  });
});

describe("parseVerdict for a proposal", () => {
  const answer = (extra: object) =>
    `\`\`\`json\n${JSON.stringify({ verdict: "approve", checked: ["a.ts:1 → fine"], findings: [], unverified: ["run the proof"], ...extra })}\n\`\`\``;

  it("hands what only a written change can show to the fixer instead of refusing", () => {
    const v = parseVerdict(answer({}), { proposal: true });
    assert.ok(v.ok && v.approve);
    assert.deepEqual(v.ok && v.approve ? v.deferred : undefined, ["run the proof"]);
  });

  it("still refuses a change with unverified items, and a proposal with a finding", () => {
    const written = parseVerdict(answer({}));
    assert.ok(written.ok && !written.approve);
    const found = parseVerdict(
      answer({ findings: [{ point: 1, problem: "p", evidence: "e", required: "r" }] }),
      { proposal: true },
    );
    assert.ok(found.ok && !found.approve);
  });
});
