import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { PROMPT_RULES, readAgentPrompt, readTemplate, renderPrompt } from "./prompt.js";

function file(name: string, content: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "slot-kit-prompt-")), name);
  writeFileSync(path, content);
  return path;
}

function promptOf(result: ReturnType<typeof renderPrompt>): string {
  assert.ok(result.ok, result.ok ? "" : result.reason);
  return result.prompt;
}

function reasonOf(result: { ok: boolean; reason?: string }): string {
  assert.ok(!result.ok);
  return result.reason ?? "";
}

describe("renderPrompt", () => {
  it("places the names it was given", () => {
    const prompt = promptOf(renderPrompt("Do: {{task}}", { task: "Ship it" }));
    assert.equal(prompt, "Do: Ship it\n");
  });

  it("refuses an unknown placeholder rather than dropping it", () => {
    const reason = reasonOf(renderPrompt("{{task}} {{repo_url}}", { task: "i" }));
    assert.match(reason, /uses \{\{repo_url\}\}, which is not a placeholder/);
    assert.match(reason, /Known: \{\{task\}\}/);
  });

  it("refuses a template that never places a required name", () => {
    assert.equal(
      reasonOf(renderPrompt("Just rules: {{rules}}", { task: "i", rules: "r" }, ["task"])),
      "The prompt template must place {{task}} somewhere.",
    );
  });

  it("counts an empty value as placed", () => {
    assert.equal(
      promptOf(renderPrompt("{{task}}{{done_when}}", { task: "i", done_when: "" })),
      "i\n",
    );
  });

  it("collapses the blank lines an emptied placeholder leaves", () => {
    const prompt = promptOf(
      renderPrompt("{{task}}\n\n{{done_when}}\n\n{{rules}}", {
        task: "i",
        done_when: "",
        rules: "r",
      }),
    );
    assert.equal(prompt, "i\n\nr\n");
  });

  it("does not invent a heading or a default for a name", () => {
    assert.equal(
      promptOf(renderPrompt("{{task}}\n{{rules}}", { task: "i", rules: PROMPT_RULES })),
      `i\n${PROMPT_RULES}\n`,
    );
  });
});

describe("readTemplate", () => {
  it("returns the fallback when no path was given", () => {
    assert.deepEqual(readTemplate(undefined, "fallback"), { ok: true, value: "fallback" });
  });

  it("reads the file at the path", () => {
    assert.deepEqual(readTemplate(file("p.md", "mine"), "fallback"), { ok: true, value: "mine" });
  });

  it("refuses a file it cannot read, and names it", () => {
    assert.match(
      reasonOf(readTemplate("/no/such/template.md", "fallback")),
      /Cannot read the prompt template/,
    );
  });

  it("refuses an empty file, which is a truncated one more often than a choice", () => {
    const path = file("empty.md", "   \n");
    assert.equal(
      reasonOf(readTemplate(path, "fallback")),
      `The prompt template at ${path} is empty.`,
    );
  });

  it("calls the file what the caller calls it", () => {
    assert.match(
      reasonOf(readTemplate(file("r.md", ""), PROMPT_RULES, "rules file")),
      /rules file/,
    );
  });
});

describe("readAgentPrompt", () => {
  it("takes --prompt as the text", () => {
    const read = readAgentPrompt({ prompt: "already filled" });
    assert.ok(read.ok);
    assert.equal(read.prompt, "already filled");
  });

  it("reads --prompt-file as the same text, without interpolating", () => {
    const read = readAgentPrompt({ promptFile: file("p.md", "raw {{task}}") });
    assert.ok(read.ok);
    assert.equal(read.prompt, "raw {{task}}");
  });

  it("refuses both, or neither", () => {
    assert.match(reasonOf(readAgentPrompt({})), /needs --prompt or --prompt-file/);
    assert.match(reasonOf(readAgentPrompt({ prompt: "a", promptFile: "b.md" })), /not both/);
  });
});
