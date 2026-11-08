import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { SupervisorConfig } from "./config.js";
import { runAgent } from "./council.js";
import type { Exec, ExecResult } from "./exec.js";

const config = {
  agents: { rootcause: { cmd: ["agent", "{prompt}"], timeoutMs: 1000 } },
} as unknown as SupervisorConfig;

function run(result: ExecResult) {
  const exec: Exec = async () => result;
  return runAgent({
    config,
    exec,
    role: "rootcause",
    prompt: "p",
    dir: mkdtempSync(join(tmpdir(), "council-")),
    cwd: ".",
    addDirs: [],
  });
}

const CUT = "killed after 1000ms, its own ceiling";

describe("runAgent", () => {
  it("keeps a complete answer from an agent cut at its ceiling", async () => {
    const stdout = 'The cause is X.\n```json\n{"cause":"X"}\n```';
    const answer = await run({ code: null, stdout, stderr: "", atCeiling: true, error: CUT });
    assert.equal(answer.ok, true);
    assert.equal(answer.text, stdout);
  });

  it("loses an answer cut at its ceiling before its JSON block", async () => {
    const answer = await run({
      code: null,
      stdout: "I am still reading the journal",
      stderr: "",
      atCeiling: true,
      error: CUT,
    });
    assert.equal(answer.ok, false);
  });

  it("loses an answer from an agent that failed for another reason", async () => {
    const answer = await run({
      code: null,
      stdout: '```json\n{"cause":"X"}\n```',
      stderr: "",
      error: "wrote more than 8388608 characters",
    });
    assert.equal(answer.ok, false);
  });
});
