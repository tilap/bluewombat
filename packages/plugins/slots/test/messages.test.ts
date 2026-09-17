import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const node = process.execPath;
const messages = join(dirname(fileURLToPath(import.meta.url)), "../messages");
const conventional = join(messages, "conventional.mjs");
const producer = join(messages, "git-producer.mjs");

function answerOf(argv: string[]): Record<string, unknown> {
  const run = spawnSync(node, argv, { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const last = run.stdout.trim().split("\n").at(-1) ?? "";
  return JSON.parse(last) as Record<string, unknown>;
}

describe("messages/conventional", () => {
  it("writes <type>: <title> and keeps the intention as the body", () => {
    const answer = answerOf([
      conventional,
      "--id",
      "github:acme/app#9",
      "--title",
      "Add three string helpers",
      "--intention",
      "Three helpers.\n\n- one\n- two",
    ]);
    assert.equal(answer.subject, "feat: add three string helpers");
    assert.equal(answer.body, "Three helpers.\n\n- one\n- two");
  });

  it("reads the type off the verb, takes a scope and a forced type", () => {
    assert.equal(
      answerOf([conventional, "--title", "Fix the off-by-one"]).subject,
      "fix: fix the off-by-one",
    );
    assert.equal(
      answerOf([conventional, "--scope", "api", "--title", "Document the endpoints"]).subject,
      "docs(api): document the endpoints",
    );
    assert.equal(
      answerOf([conventional, "--type", "chore", "--title", "Add a helper"]).subject,
      "chore: add a helper",
    );
  });

  it("leaves no body without an intention, and fits the subject in 72", () => {
    const answer = answerOf([conventional, "--title", "Add a truncate helper"]);
    assert.equal(answer.body, undefined);
    const wide = answerOf([
      conventional,
      "--title",
      `Add ${"a very long name ".repeat(8)}to the library`,
    ]);
    assert.ok(String(answer.subject).length <= 72 && String(wide.subject).length <= 72);
    assert.match(String(wide.subject), /…$/);
  });
});

describe("messages/producer", () => {
  /** An agent stand-in: reads `{{out}}` off the prompt and writes the answer there. */
  function agentAnswering(dir: string): string {
    const agent = join(dir, "agent.mjs");
    writeFileSync(
      agent,
      [
        'import { readFileSync, writeFileSync } from "node:fs";',
        'const at = process.argv.indexOf("--prompt-file");',
        'const prompt = readFileSync(process.argv[at + 1], "utf8");',
        "const out = /to this file:\\n\\n(\\S+)/.exec(prompt)[1];",
        'const rule = prompt.includes("ninety") ? "ninety" : "default";',
        'writeFileSync(out, JSON.stringify({ subject: "feat: add slugify (" + rule + ")", body: "Because." }));',
        'process.stdout.write(JSON.stringify({ name: "stub", bin: "stub", code: 0, signal: null, stdout: "", stderr: "", output: "", startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), durationMs: 1 }) + "\\n");',
        "",
      ].join("\n"),
    );
    return agent;
  }

  it("fills the template, spawns the agent, and reads the JSON the agent wrote", () => {
    const dir = mkdtempSync(join(tmpdir(), "message-agent-"));
    const agent = agentAnswering(dir);
    const rules = join(dir, "rules.md");
    writeFileSync(rules, "- at most ninety characters\n");

    const plain = answerOf([
      producer,
      "--id",
      "k",
      "--title",
      "Add slugify",
      "--intention",
      "Because.",
      "--",
      node,
      agent,
    ]);
    assert.deepEqual(plain, { subject: "feat: add slugify (default)", body: "Because." });

    const guided = answerOf([
      producer,
      "--rules-file",
      rules,
      "--id",
      "k",
      "--title",
      "Add slugify",
      "--",
      node,
      agent,
    ]);
    assert.equal(guided.subject, "feat: add slugify (ninety)");
  });

  it("fails, and says why, when the agent wrote nothing usable", () => {
    const dir = mkdtempSync(join(tmpdir(), "message-agent-"));
    const silent = join(dir, "silent.mjs");
    writeFileSync(
      silent,
      'process.stdout.write(JSON.stringify({ name: "stub", bin: "stub", code: 0, signal: null, stdout: "", stderr: "", output: "", startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), durationMs: 1 }) + "\\n");\n',
    );
    const run = spawnSync(node, [producer, "--title", "Add slugify", "--", node, silent], {
      encoding: "utf8",
    });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /no usable message/);
  });
});
