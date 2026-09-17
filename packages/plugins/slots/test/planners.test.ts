import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const node = process.execPath;
const here = dirname(fileURLToPath(import.meta.url));
const planner = join(here, "../planners/producer.mjs");
const cursor = join(here, "../agents/cursor.mjs");
const fixtures = join(here, "../fixtures");

function run(extra: string[]) {
  const agent: string[] = [];
  const roleFlags: string[] = [];
  for (let i = 0; i < extra.length; i++) {
    if (extra[i] === "--bin") {
      agent.push("--bin", extra[i + 1] ?? "");
      i += 1;
      continue;
    }
    roleFlags.push(extra[i] as string);
  }
  return spawnSync(
    node,
    [
      planner,
      ...roleFlags,
      "--",
      node,
      cursor,
      ...agent,
      "--key",
      "fake:1",
      "--intention",
      "Add an export",
      "--max-units",
      "5",
    ],
    { cwd: mkdtempSync(join(tmpdir(), "planner-")), encoding: "utf8" },
  );
}

function answerOf(stdout: string): {
  subtasks?: { id: string; depends_on?: string[] }[];
  outcome?: string;
  code?: string;
  reason?: unknown;
} {
  const last = stdout.trim().split("\n").filter(Boolean).at(-1);
  assert.ok(last !== undefined, `stdout: ${stdout}`);
  return JSON.parse(last) as {
    subtasks?: { id: string; depends_on?: string[] }[];
    outcome?: string;
    code?: string;
    reason?: unknown;
  };
}

describe("planner producer", () => {
  it("returns the plan the agent wrote", () => {
    const result = run(["--bin", join(fixtures, "planner-agent-ok.mjs")]);
    assert.equal(result.status, 0, result.stderr);
    const plan = answerOf(result.stdout);
    assert.deepEqual(
      (plan.subtasks ?? []).map((subtask) => subtask.id),
      ["s1", "s2"],
    );
    assert.deepEqual(plan.subtasks?.[1]?.depends_on, ["s1"]);
  });

  it("reads a plan the agent wrapped in a fence", () => {
    const result = run(["--bin", join(fixtures, "planner-agent-fenced.mjs")]);
    assert.equal(result.status, 0, result.stderr);
    const plan = answerOf(result.stdout);
    assert.equal(plan.subtasks?.[0]?.id, "only");
  });

  it("passes a refusal through as a verdict on the feature", () => {
    const result = run(["--bin", join(fixtures, "planner-agent-refuses.mjs")]);
    assert.equal(result.status, 0, result.stderr);
    const answer = answerOf(result.stdout);
    assert.equal(answer.outcome, "refused");
    assert.equal(answer.code, "not-specifiable");
    assert.match(String(answer.reason), /two opposite results/);
  });

  it("fails rather than refuses when the plan cannot be used", () => {
    const result = run(["--bin", join(fixtures, "planner-agent-cycle.mjs")]);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout.trim(), "");
    assert.match(result.stderr, /cycle: a → b → a/);
  });

  it("fails when the agent wrote no answer at all", () => {
    const result = run(["--bin", join(fixtures, "planner-agent-silent.mjs")]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /no usable plan/);
  });

  it("refuses an option it does not have", () => {
    const result = run(["--bin", join(fixtures, "planner-agent-ok.mjs"), "--workspace", "x"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /planner producer does not take "--workspace"/);
  });

  it("fails when there is no agent to run", () => {
    const result = run(["--bin", "/nonexistent/agent"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Could not start/);
  });

  it("fails when no agent command follows --", () => {
    const result = spawnSync(node, [planner, "--intention", "x", "--max-units", "5"], {
      cwd: mkdtempSync(join(tmpdir(), "planner-")),
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /agent command after --/);
  });

  it("takes the prompt from --prompt-file", () => {
    const cwd = mkdtempSync(join(tmpdir(), "planner-"));
    const template = join(cwd, "plan.md");
    writeFileSync(template, "House rules.\n\n{{intention}}\n\nWrite to:\n{{out}}\n");
    const result = run([
      "--prompt-file",
      template,
      "--bin",
      join(fixtures, "planner-agent-ok.mjs"),
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(answerOf(result.stdout).subtasks?.length, 2);
  });

  it("fails on a template placeholder it does not know", () => {
    const cwd = mkdtempSync(join(tmpdir(), "planner-"));
    const template = join(cwd, "plan.md");
    writeFileSync(template, "{{intention}}\n{{out}}\n{{criteria}}\n");
    const result = run([
      "--prompt-file",
      template,
      "--bin",
      join(fixtures, "planner-agent-ok.mjs"),
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /\{\{criteria\}\}/);
  });

  it("fails on a template that never says where to write", () => {
    const cwd = mkdtempSync(join(tmpdir(), "planner-"));
    const template = join(cwd, "plan.md");
    writeFileSync(template, "Split this: {{intention}}\n");
    const result = run([
      "--prompt-file",
      template,
      "--bin",
      join(fixtures, "planner-agent-ok.mjs"),
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /\{\{out\}\}/);
  });
});
