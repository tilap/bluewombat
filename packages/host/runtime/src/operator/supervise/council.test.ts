import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { SupervisorConfig } from "./config.js";
import { deliberate, runAgent } from "./council.js";
import type { Exec, ExecResult } from "./exec.js";
import type { Brief } from "./prompts.js";

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

describe("deliberate", () => {
  const roles = ["rootcause", "remedy", "skeptic", "arbiter", "reformatter"];
  const council = {
    agents: Object.fromEntries(
      roles.map((role) => [role, { cmd: [role, "{prompt}"], timeoutMs: 1000 }]),
    ),
    targets: [{ name: "mason" }],
  } as unknown as SupervisorConfig;
  const brief = {
    finding: { kind: "escalated", scope: "ticket", key: "k#1", detail: "d" },
    ledgerRoot: "/ledger",
    codeRoots: [],
    targets: ["mason"],
    rules: [],
    history: [],
  } as unknown as Brief;
  const good =
    '```json\n{"summary":"s","cause":"c","evidence":["e"],"confidence":"high","unblockAfterFixes":false,"unblock":[],"fixes":[],"needsHuman":""}\n```';

  it("corrects a refused arbiter answer from its own text, without the three reports", async () => {
    const calls: { role: string; prompt: string }[] = [];
    const exec: Exec = async (cmd) => {
      const role = cmd[0] ?? "";
      const prompt = cmd[1] ?? "";
      calls.push({ role, prompt });
      const stdout =
        role === "arbiter"
          ? "The cause is X, but I forgot the block."
          : role === "reformatter"
            ? good
            : "REPORT";
      return { code: 0, stdout, stderr: "" };
    };
    const got = await deliberate({
      config: council,
      exec,
      brief,
      dir: mkdtempSync(join(tmpdir(), "council-")),
      cwd: ".",
    });
    assert.equal(got.ok, true);
    assert.equal(calls.filter((c) => c.role === "arbiter").length, 1);
    const second = calls.find((c) => c.role === "reformatter");
    assert.match(second?.prompt ?? "", /The cause is X, but I forgot the block\./);
    assert.doesNotMatch(second?.prompt ?? "", /REPORT/);
  });

  it("gives up when the corrected answer is refused too, without rerunning the arbiter", async () => {
    const calls: string[] = [];
    const exec: Exec = async (cmd) => {
      calls.push(cmd[0] ?? "");
      return { code: 0, stdout: "no block", stderr: "" };
    };
    const got = await deliberate({
      config: council,
      exec,
      brief,
      dir: mkdtempSync(join(tmpdir(), "council-")),
      cwd: ".",
    });
    assert.equal(got.ok, false);
    assert.equal(calls.filter((c) => c === "arbiter").length, 1);
  });
});
