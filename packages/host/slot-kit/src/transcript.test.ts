import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AgentRun } from "./agent.js";
import { openTranscript, TRANSCRIPT_PARTS } from "./transcript.js";

function sandbox(): string {
  return mkdtempSync(join(tmpdir(), "slot-kit-transcript-"));
}

function ran(over: Partial<AgentRun> = {}): AgentRun {
  const startedAt = new Date("2026-09-08T10:00:00.000Z");
  return {
    code: 0,
    signal: null,
    stdout: "the agent's answer",
    stderr: "the agent's narration",
    output: "",
    startedAt,
    endedAt: new Date("2026-09-08T10:00:02.500Z"),
    durationMs: 2500,
    ...over,
  };
}

/** The one file a transcript wrote, wherever under `dir` it landed. */
function wrote(dir: string): { name: string; text: string } {
  const contexts = readdirSync(dir);
  assert.equal(contexts.length, 1);
  const context = contexts[0];
  assert.ok(context !== undefined);
  const files = readdirSync(join(dir, context));
  assert.equal(files.length, 1);
  const name = files[0];
  assert.ok(name !== undefined);
  return { name: join(context, name), text: readFileSync(join(dir, context, name), "utf8") };
}

describe("openTranscript", () => {
  it("writes nothing at all without a directory", () => {
    const dir = sandbox();
    openTranscript({ id: "t" }).write(ran());
    assert.deepEqual(readdirSync(dir), []);
  });

  it("files the turn under a slug of its context", () => {
    const dir = sandbox();
    openTranscript({ dir, context: "GitHub: Issue #12", id: "s1", attempt: 2 }).write(ran());
    const { name } = wrote(dir);
    assert.match(name, /^github-issue-12\//);
    assert.match(name, /s1-attempt-2-20260908T100000Z\.md$/);
  });

  it("falls back to names when the slot said nothing", () => {
    const dir = sandbox();
    openTranscript({ dir }).write(ran());
    assert.match(wrote(dir).name, /^no-context\/task-attempt-1-/);
  });

  it("keeps every part by default", () => {
    const dir = sandbox();
    openTranscript({
      dir,
      id: "s1",
      slot: "Cursor CLI",
      bin: "/bin/cursor-agent",
      args: ["-p", "the prompt text"],
      prompt: "the prompt text",
    }).write(ran());
    const { text } = wrote(dir);
    assert.match(text, /- slot: Cursor CLI/);
    assert.match(text, /- agent: \/bin\/cursor-agent/);
    assert.match(text, /- duration: 2\.5s/);
    assert.match(text, /## Invocation/);
    assert.match(text, /## Prompt/);
    assert.match(text, /## stdout/);
    assert.match(text, /## stderr/);
  });

  it("keeps only the parts asked for", () => {
    const dir = sandbox();
    openTranscript({ dir, parts: ["timing"], prompt: "secret", args: ["secret"] }).write(ran());
    const { text } = wrote(dir);
    assert.match(text, /- duration: 2\.5s/);
    assert.doesNotMatch(text, /secret/);
    assert.doesNotMatch(text, /## stdout/);
  });

  it("replaces the prompt in the invocation, so the flags stay readable", () => {
    const dir = sandbox();
    openTranscript({
      dir,
      parts: ["prompt"],
      args: ["-p", "--model", "opus", "a very long prompt"],
      prompt: "a very long prompt",
    }).write(ran());
    assert.match(wrote(dir).text, /-p --model opus <prompt>/);
  });

  it("fences agent output that contains a fence of its own", () => {
    const dir = sandbox();
    openTranscript({ dir, parts: ["stdout"] }).write(ran({ stdout: "```js\ncode\n```" }));
    assert.match(wrote(dir).text, /````\n```js\ncode\n```\n````/);
  });

  it("marks an empty section rather than leaving a bare fence", () => {
    const dir = sandbox();
    openTranscript({ dir, parts: ["stdout"] }).write(ran({ stdout: "  " }));
    assert.match(wrote(dir).text, /## stdout\n\n_\(empty\)_/);
  });

  it("says a CLI never started instead of an exit code", () => {
    const dir = sandbox();
    openTranscript({ dir, parts: ["timing"] }).write(ran({ error: new Error("ENOENT") }));
    assert.match(wrote(dir).text, /- exit: did not start: ENOENT/);
  });

  it("survives a directory it cannot write to", () => {
    // Losing a transcript is worth a word on stderr and nothing more.
    const dir = join(sandbox(), "file-not-a-dir");
    writeFileSync(dir, "");
    assert.doesNotThrow(() => {
      openTranscript({ dir }).write(ran());
    });
    assert.ok(existsSync(dir));
  });

  it("names the parts a slot may ask for", () => {
    assert.deepEqual([...TRANSCRIPT_PARTS], ["prompt", "stdout", "stderr", "timing"]);
  });
});
