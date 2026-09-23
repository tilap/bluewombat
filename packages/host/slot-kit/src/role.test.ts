import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BUILDER_FLAGS } from "./argv.js";
import {
  fillPrompt,
  loadPrompt,
  loadRules,
  parseRole,
  spawnFilled,
  transcriptArgs,
} from "./role.js";

const argv = (...tokens: string[]): string[] => ["node", "role.mjs", ...tokens];

/** An agent stand-in: echoes the prompt it was handed as a serialized run. */
function agentScript(body: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "slot-kit-")), "agent.mjs");
  writeFileSync(path, body);
  return path;
}

const ECHO_AGENT = agentScript(`
import { readFileSync } from "node:fs";
const at = process.argv.indexOf("--prompt-file");
const prompt = readFileSync(process.argv[at + 1], "utf8");
const rest = process.argv.slice(2).filter((_, i) => i !== at - 2 && i !== at - 1);
process.stdout.write("noise\\n");
process.stdout.write(JSON.stringify({
  name: "echo", bin: "/bin/echo", code: 0, signal: null,
  stdout: prompt, stderr: rest.join(" "), output: prompt,
  startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:00:01.000Z", durationMs: 1000,
}) + "\\n");
`);

describe("parseRole", () => {
  it("keeps the role's flags and the runner, drops the caller's", () => {
    const parsed = parseRole(
      argv("--intention", "x", "--prompt-file", "p.md", "--", "node", "agent.mjs", "--model", "m"),
      BUILDER_FLAGS,
      "builder",
    );
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.options, { promptFile: "p.md" });
    assert.deepEqual(parsed.runner, ["node", "agent.mjs", "--model", "m"]);
  });

  it("takes extra flags a role adds to the shared set", () => {
    const parsed = parseRole(argv("--read", "/src", "--", "a"), BUILDER_FLAGS, "planner", {
      "--read": {},
    });
    assert.ok(parsed.ok);
    assert.equal(parsed.options.read, "/src");
  });

  it("refuses when there is no agent after --", () => {
    for (const tokens of [argv("--prompt-file", "p.md"), argv("--prompt-file", "p.md", "--")]) {
      const parsed = parseRole(tokens, BUILDER_FLAGS, "builder");
      assert.ok(!parsed.ok);
      assert.equal(parsed.reason, "The builder needs an agent command after --.");
    }
  });

  it("refuses a flag meant for the agent", () => {
    const parsed = parseRole(argv("--model", "m", "--", "a"), BUILDER_FLAGS, "builder");
    assert.ok(!parsed.ok);
    assert.equal(parsed.reason, 'The builder does not take "--model".');
  });
});

describe("loadPrompt / loadRules", () => {
  it("fall back to the built-in text when no file is given", () => {
    assert.deepEqual(loadPrompt({}, "built-in"), { ok: true, value: "built-in" });
    assert.deepEqual(loadRules({}, "- rule"), { ok: true, value: "- rule" });
  });

  it("name what could not be read", () => {
    const rules = loadRules({ rulesFile: "/nowhere/rules.md" }, "");
    assert.ok(!rules.ok);
    assert.match(rules.reason, /^Cannot read the rules file at \/nowhere\/rules\.md/);
  });
});

describe("fillPrompt", () => {
  it("says where the template came from when it refuses", () => {
    const rendered = fillPrompt("{{task}} {{typo}}", { task: "t" }, ["task"], "custom.md");
    assert.ok(!rendered.ok);
    assert.match(rendered.reason, /\(custom\.md\)$/);
  });
});

describe("transcriptArgs", () => {
  it("forwards what the caller passed, in a fixed order", () => {
    assert.deepEqual(transcriptArgs(argv("--context", "c", "--id", "s1", "--attempt", "2")), [
      "--id",
      "s1",
      "--attempt",
      "2",
      "--context",
      "c",
    ]);
  });

  it("lets a role override a value and leaves out what nobody set", () => {
    assert.deepEqual(transcriptArgs(argv("--id", "s1"), { id: "breakdown", context: "k" }), [
      "--id",
      "breakdown",
      "--context",
      "k",
    ]);
    assert.deepEqual(transcriptArgs(argv()), []);
  });
});

describe("spawnFilled", () => {
  it("hands the prompt over as a file and reads the run back", async () => {
    const spawned = await spawnFilled(["node", ECHO_AGENT], "do the thing\n", ["--id", "s1"]);
    assert.ok(spawned.ok);
    assert.equal(spawned.run.stdout, "do the thing\n");
    assert.equal(spawned.run.stderr, "--id s1");
    assert.equal(spawned.run.code, 0);
    assert.deepEqual(spawned.about, { name: "echo", bin: "/bin/echo" });
  });

  it("refuses an empty command", async () => {
    const spawned = await spawnFilled([], "p");
    assert.deepEqual(spawned, { ok: false, reason: "The agent command is empty." });
  });

  it("refuses when the agent wrote no result", async () => {
    const silent = agentScript("process.stdout.write('nothing structured\\n');");
    const spawned = await spawnFilled(["node", silent], "p");
    assert.deepEqual(spawned, { ok: false, reason: "The agent command wrote no result." });
  });

  it("reads a large serialized run after an immediate exit", async () => {
    // Agents must writeSync the contract line: process.stdout.write + process.exit
    // drops the tail above ~8KiB, which is exactly "wrote no result" for a real
    // stream-json transcript. writeContract in the shipped agents is that write.
    const large = agentScript(`
import { writeSync } from "node:fs";
const body = "x".repeat(32_000);
writeSync(1, JSON.stringify({
  name: "big", bin: "/bin/x", code: 0, signal: null,
  stdout: body, stderr: "", output: body,
  startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:00:01.000Z", durationMs: 1000,
}) + "\\n");
process.exit(0);
`);
    const spawned = await spawnFilled(["node", large], "p");
    assert.ok(spawned.ok);
    assert.equal(spawned.run.stdout.length, 32_000);
    assert.equal(spawned.run.code, 0);
  });

  it("relays a pre-run refusal", async () => {
    const refusing = agentScript(
      "process.stdout.write(JSON.stringify({ error: 'No cursor-agent on PATH.' }) + '\\n');",
    );
    const spawned = await spawnFilled(["node", refusing], "p");
    assert.deepEqual(spawned, { ok: false, reason: "No cursor-agent on PATH." });
  });

  it("names a command that could not start", async () => {
    const spawned = await spawnFilled(["/nowhere/agent"], "p");
    assert.ok(!spawned.ok);
    assert.match(spawned.reason, /^Could not start the agent command at \/nowhere\/agent: /);
  });
});
