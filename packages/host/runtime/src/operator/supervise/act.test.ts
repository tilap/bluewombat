import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { carryOut, type Hands } from "./act.js";
import type { CommandSpec, FixTarget, SupervisorConfig } from "./config.js";
import type { Decision } from "./decision.js";
import type { Exec, ExecResult } from "./exec.js";

const spec = (...cmd: string[]): CommandSpec => ({ cmd, timeoutMs: 1000 });
const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const bad = (stderr: string): ExecResult => ({ code: 1, stdout: "", stderr });

function config(dir: string, extra: Partial<FixTarget> = {}): SupervisorConfig {
  const target: FixTarget = {
    name: "mason",
    repo: "/repo",
    base: "main",
    remote: "origin",
    checks: [spec("npm", "test")],
    open: spec("gh", "pr", "create", "{branch}", "{title}"),
    autoMerge: true,
    merge: spec("gh", "pr", "merge", "{pr}"),
    merged: spec("gh", "pr", "merged", "{pr}"),
    after: [],
    deny: ["scripts/"],
    rules: ["AGENTS.md"],
    ...extra,
  };
  return {
    configDir: dir,
    dir,
    pollIntervalMs: 1,
    stallAfterMs: 1,
    settleMs: 0,
    cooldownMs: 0,
    diskMinBytes: 0,
    maxAttempts: 3,
    agents: { fixer: spec("agent", "{prompt}"), reviewer: spec("agent", "{prompt}") },
    worker: {},
    resume: spec("signal-resume", "{key}", "{number}"),
    diskCleanup: [],
    targets: [target],
  };
}

const decision = (extra: Partial<Decision> = {}): Decision => ({
  summary: "s",
  cause: "c",
  evidence: ["e"],
  confidence: "high",
  unblockAfterFixes: false,
  unblock: [{ do: "resume", key: "github:o/r#34", reason: "r" }],
  fixes: [
    {
      target: "mason",
      title: "Fix the thing",
      instruction: "Change a to b everywhere.",
      conformity: "AGENTS.md: minimal diff; touches no decision",
    },
  ],
  ...extra,
});

const APPROVE = `\`\`\`json\n${JSON.stringify({ verdict: "approve", checked: ["a.ts:1 → fine"], findings: [], unverified: [] })}\n\`\`\``;
const REJECT = `\`\`\`json\n${JSON.stringify({ verdict: "reject", checked: [], findings: [{ point: 3, problem: "contradicts D12", evidence: "DECISIONS.md:40", required: "record the new decision" }] })}\n\`\`\``;

const hands: Hands = {
  restart: async () => ({ what: "restart", ok: true, detail: "" }),
  cancel: async () => ({ what: "cancel", ok: true, detail: "" }),
  startWorker: async () => ({ what: "start", ok: true, detail: "" }),
  restartWorker: async () => ({ what: "restart-worker", ok: true, detail: "" }),
};

/** A fake world: git and gh answer by their words; `fail` makes one command fail. */
function world(
  options: {
    dirty?: string;
    fail?: (cmd: string[]) => string | undefined;
    merged?: number;
    /** What the guard answers about the change, one per ask; the last repeats. Default: approve. */
    guard?: string[];
    /** What it answers about the proposal. Default: approve. */
    proposal?: string[];
  } = {},
) {
  const guard = options.guard ?? [APPROVE];
  const proposal = options.proposal ?? [APPROVE];
  let guardAsked = 0;
  let proposalAsked = 0;
  const calls: string[][] = [];
  let mergedAsked = 0;
  const exec: Exec = async (cmd) => {
    calls.push(cmd);
    if (cmd[0] === "agent" && cmd[1]?.includes("is PROPOSED")) {
      return ok(proposal[Math.min(proposalAsked++, proposal.length - 1)]);
    }
    if (cmd[0] === "agent" && cmd[1]?.includes("You are the guard")) {
      return ok(guard[Math.min(guardAsked++, guard.length - 1)]);
    }
    const failure = options.fail?.(cmd);
    if (failure !== undefined) {
      return bad(failure);
    }
    const line = cmd.join(" ");
    if (line.includes("status --porcelain")) {
      return ok(options.dirty ?? " M src/a.ts\n");
    }
    if (cmd[0] === "gh" && cmd[2] === "create") {
      return ok("https://github.com/o/r/pull/9\n");
    }
    if (cmd[0] === "gh" && cmd[2] === "merged") {
      mergedAsked += 1;
      return mergedAsked > (options.merged ?? 1) ? ok() : bad("open");
    }
    return ok();
  };
  return { calls, exec };
}

const ran = (calls: string[][], word: string) =>
  calls.findIndex((c) => c[0] !== "agent" && c.join(" ").includes(word));

function context(w: ReturnType<typeof world>, cfg: SupervisorConfig) {
  return {
    config: cfg,
    exec: w.exec,
    hands,
    dir: mkdtempSync(join(tmpdir(), "act-")),
    sleep: async () => {},
  };
}

describe("carryOut", () => {
  it("unblocks first when the stop would not come back, then fixes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "act-cfg-"));
    const w = world();
    const outcomes = await carryOut(decision(), context(w, config(dir)));
    assert.ok(
      outcomes.every((o) => o.ok),
      JSON.stringify(outcomes),
    );
    assert.ok(
      ran(w.calls, "signal-resume github:o/r#34 34") >= 0,
      "resume gets the tracker number",
    );
    assert.ok(ran(w.calls, "signal-resume") < ran(w.calls, "worktree add"));
  });

  it("lands the fix before the unblock when the arbiter says the stop would return", async () => {
    const dir = mkdtempSync(join(tmpdir(), "act-cfg-"));
    const w = world();
    const outcomes = await carryOut(decision({ unblockAfterFixes: true }), context(w, config(dir)));
    assert.ok(
      outcomes.every((o) => o.ok),
      JSON.stringify(outcomes),
    );
    assert.ok(ran(w.calls, "pr merge") < ran(w.calls, "signal-resume"));
    assert.ok(ran(w.calls, "push") >= 0 && ran(w.calls, "commit") < ran(w.calls, "push"));
  });

  it("holds the unblock back when the fix does not pass its checks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "act-cfg-"));
    const w = world({ fail: (cmd) => (cmd[0] === "npm" ? "2 tests failed" : undefined) });
    const outcomes = await carryOut(decision({ unblockAfterFixes: true }), context(w, config(dir)));
    assert.equal(outcomes[0]?.ok, false);
    assert.match(outcomes[0]?.detail ?? "", /no passing change/);
    assert.equal(outcomes[1]?.what, "unblock");
    assert.equal(ran(w.calls, "signal-resume"), -1, "nothing was resumed");
    assert.ok(ran(w.calls, "worktree remove") >= 0, "the worktree is cleaned up either way");
    assert.equal(ran(w.calls, "push"), -1, "a change that fails its checks is not offered");
  });

  it("refuses a change that touches a denied path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "act-cfg-"));
    const w = world({ dirty: " M scripts/release.mjs\n" });
    const outcomes = await carryOut(decision({ unblock: [] }), context(w, config(dir)));
    assert.equal(outcomes[0]?.ok, false);
    assert.match(outcomes[0]?.detail ?? "", /scripts\/release\.mjs/);
    assert.equal(ran(w.calls, "push"), -1);
  });

  it("waits for the fold, then runs what follows it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "act-cfg-"));
    const w = world({ merged: 3 });
    const outcomes = await carryOut(
      decision({ unblock: [] }),
      context(w, config(dir, { after: [spec("release-and-restart", "{branch}")] })),
    );
    assert.ok(outcomes[0]?.ok, JSON.stringify(outcomes));
    assert.equal(w.calls.filter((c) => c[2] === "merged").length, 4);
    assert.ok(ran(w.calls, "release-and-restart") > ran(w.calls, "pr merge"));
  });

  it("says so when resume is not configured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "act-cfg-"));
    const cfg = config(dir);
    delete cfg.resume;
    const outcomes = await carryOut(decision({ fixes: [] }), context(world(), cfg));
    assert.equal(outcomes[0]?.ok, false);
    assert.match(outcomes[0]?.detail ?? "", /resume/);
  });

  it("sends the fixer back with the guard's reasons, then commits what the guard approves", async () => {
    const dir = mkdtempSync(join(tmpdir(), "act-cfg-"));
    const w = world({ guard: [REJECT, APPROVE] });
    const outcomes = await carryOut(decision({ unblock: [] }), context(w, config(dir)));
    assert.ok(outcomes[0]?.ok, JSON.stringify(outcomes));
    const fixerPrompts = w.calls.filter(
      (c) => c[0] === "agent" && c[1]?.includes("You change one"),
    );
    assert.equal(fixerPrompts.length, 2);
    assert.match(fixerPrompts[1]?.[1] ?? "", /contradicts D12/);
    assert.ok(ran(w.calls, "push") >= 0);
  });

  it("offers nothing the guard keeps rejecting", async () => {
    const dir = mkdtempSync(join(tmpdir(), "act-cfg-"));
    const w = world({ guard: [REJECT] });
    const outcomes = await carryOut(decision({ unblock: [] }), context(w, config(dir)));
    assert.equal(outcomes[0]?.ok, false);
    assert.equal(ran(w.calls, "push"), -1);
  });

  it("offers nothing when the guard cannot give a verdict", async () => {
    const dir = mkdtempSync(join(tmpdir(), "act-cfg-"));
    const w = world({ guard: ["I looked and it seems fine."] });
    const outcomes = await carryOut(decision({ unblock: [] }), context(w, config(dir)));
    assert.equal(outcomes[0]?.ok, false);
    assert.match(outcomes[0]?.detail ?? "", /guard could not give a verdict/);
    assert.equal(ran(w.calls, "push"), -1);
  });

  it("without autoMerge, offers the change and leaves the fold to a person", async () => {
    const dir = mkdtempSync(join(tmpdir(), "act-cfg-"));
    const w = world();
    const outcomes = await carryOut(
      decision({ unblockAfterFixes: true }),
      context(w, config(dir, { autoMerge: false })),
    );
    assert.equal(ran(w.calls, "pr merge"), -1);
    assert.equal(outcomes[0]?.pending, true);
    assert.equal(ran(w.calls, "signal-resume"), -1, "nothing waits on a fix that is not folded");
    assert.match(outcomes[1]?.detail ?? "", /wait for a person/);
  });

  it("writes nothing when the guard refuses the proposal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "act-cfg-"));
    const w = world({ proposal: [REJECT] });
    const outcomes = await carryOut(decision({ unblock: [] }), context(w, config(dir)));
    assert.equal(outcomes[0]?.ok, false);
    assert.match(outcomes[0]?.detail ?? "", /refused the proposal before it was written/);
    assert.equal(
      w.calls.filter((c) => c[0] === "agent" && c[1]?.includes("You change one")).length,
      0,
      "the fixer never ran",
    );
  });

  it("does not make a fix that revises an accepted decision", async () => {
    const dir = mkdtempSync(join(tmpdir(), "act-cfg-"));
    const w = world();
    const fix = {
      ...decision().fixes[0],
      revises: "DECISIONS row 64",
    } as Decision["fixes"][number];
    const outcomes = await carryOut(
      decision({ unblock: [], fixes: [fix] }),
      context(w, config(dir)),
    );
    assert.equal(outcomes[0]?.ok, false);
    assert.match(outcomes[0]?.detail ?? "", /revise DECISIONS row 64/);
    assert.equal(ran(w.calls, "worktree add"), -1);
  });

  it("stops when the guard rejects the same point twice in a row", async () => {
    const dir = mkdtempSync(join(tmpdir(), "act-cfg-"));
    const w = world({ guard: [REJECT] });
    const outcomes = await carryOut(decision({ unblock: [] }), context(w, config(dir)));
    assert.match(outcomes[0]?.detail ?? "", /rejected point 3 twice in a row/);
    assert.equal(
      w.calls.filter((c) => c[0] === "agent" && c[1]?.includes("You change one")).length,
      2,
      "no third round",
    );
  });
});
