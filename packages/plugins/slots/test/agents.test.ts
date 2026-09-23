import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const node = process.execPath;
const here = dirname(fileURLToPath(import.meta.url));
const cursor = join(here, "../agents/cursor.mjs");
const claude = join(here, "../agents/claude.mjs");
const fixtures = join(here, "../fixtures");
const agentEchoArgv = join(fixtures, "agent-echo-argv.mjs");
const streamSkills = join(fixtures, "cursor-stream-skills.jsonl");

function sandbox() {
  return mkdtempSync(join(tmpdir(), "mason-agent-"));
}

function lastPayload(stdout: string): Record<string, unknown> {
  const last = stdout.trim().split("\n").filter(Boolean).at(-1);
  assert.ok(last !== undefined);
  return JSON.parse(last) as Record<string, unknown>;
}

describe("cursor agent", () => {
  it("passes --prompt through without interpolating", () => {
    const cwd = sandbox();
    const result = spawnSync(
      node,
      [cursor, "--bin", agentEchoArgv, "--prompt", "raw {{task}} text"],
      { cwd, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const argv = JSON.parse(readFileSync(join(cwd, "argv.json"), "utf8")) as string[];
    assert.equal(argv.at(-1), "raw {{task}} text");
    const payload = lastPayload(result.stdout);
    assert.equal(payload.name, "Cursor CLI");
    assert.equal(payload.code, 0);
    // Echo fixture is one result line: parsed, no skill reads → [] not null.
    assert.deepEqual(payload.skills, []);
    assert.equal(payload.usage, null);
  });

  it("defaults to stream-json so tool events can be read", () => {
    const cwd = sandbox();
    const result = spawnSync(node, [cursor, "--bin", agentEchoArgv, "--prompt", "hi"], {
      cwd,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const argv = JSON.parse(readFileSync(join(cwd, "argv.json"), "utf8")) as string[];
    const formatAt = argv.indexOf("--output-format");
    assert.notEqual(formatAt, -1);
    assert.equal(argv[formatAt + 1], "stream-json");
  });

  it("puts skills and usage on the serialized line from stream-json stdout", () => {
    const cwd = sandbox();
    const fakeVendor = join(cwd, "vendor.mjs");
    const body = readFileSync(streamSkills, "utf8");
    writeFileSync(
      fakeVendor,
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync("argv.json", JSON.stringify(process.argv.slice(2)));
process.stdout.write(${JSON.stringify(body)});
`,
      { mode: 0o755 },
    );
    const result = spawnSync(node, [cursor, "--bin", fakeVendor, "--prompt", "hi"], {
      cwd,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const payload = lastPayload(result.stdout);
    assert.deepEqual(payload.skills, ["thin-slice"]);
    assert.deepEqual(payload.usage, {
      input: 10077,
      output: 436,
      cacheRead: 26624,
      cacheWrite: 0,
      costUsd: null,
    });
  });

  it("delivers a large serialized run after process.exit", () => {
    // stream-json transcripts are tens to hundreds of KiB; serializeRun embeds
    // stdout twice. writeContract must land the whole line before exit.
    const cwd = sandbox();
    const fakeVendor = join(cwd, "vendor.mjs");
    const blob = `${'{"type":"thinking","text":"x"}\n'.repeat(2_000)}{"type":"result","subtype":"success","is_error":false,"result":"ok","usage":{"inputTokens":1,"outputTokens":1,"cacheReadTokens":0,"cacheWriteTokens":0}}\n`;
    writeFileSync(
      fakeVendor,
      `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(blob)});
`,
      { mode: 0o755 },
    );
    const result = spawnSync(node, [cursor, "--bin", fakeVendor, "--prompt", "hi"], {
      cwd,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    assert.equal(result.status, 0, result.stderr);
    const payload = lastPayload(result.stdout);
    assert.equal(payload.name, "Cursor CLI");
    assert.equal(typeof payload.stdout, "string");
    assert.ok((payload.stdout as string).length > 16_000);
    assert.equal(payload.code, 0);
  });

  it("leaves skills unknown when --output-format is json", () => {
    const cwd = sandbox();
    const fakeVendor = join(cwd, "vendor.mjs");
    const body = readFileSync(streamSkills, "utf8");
    writeFileSync(
      fakeVendor,
      `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(body)});
`,
      { mode: 0o755 },
    );
    const result = spawnSync(
      node,
      [cursor, "--bin", fakeVendor, "--output-format", "json", "--prompt", "hi"],
      { cwd, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const payload = lastPayload(result.stdout);
    assert.equal(payload.skills, null);
  });

  it("reads --prompt-file as the same raw text", () => {
    const cwd = sandbox();
    const file = join(cwd, "p.md");
    writeFileSync(file, "from file {{report}}");
    const result = spawnSync(node, [cursor, "--bin", agentEchoArgv, "--prompt-file", file], {
      cwd,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const argv = JSON.parse(readFileSync(join(cwd, "argv.json"), "utf8")) as string[];
    assert.equal(argv.at(-1), "from file {{report}}");
  });

  it("refuses when neither prompt is given", () => {
    const cwd = sandbox();
    const result = spawnSync(node, [cursor, "--bin", agentEchoArgv], { cwd, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    const payload = JSON.parse(result.stdout.trim()) as { error: string };
    assert.match(payload.error, /--prompt or --prompt-file/);
  });
});

describe("claude agent", () => {
  it("passes --verbose with stream-json", () => {
    const cwd = sandbox();
    const result = spawnSync(node, [claude, "--bin", agentEchoArgv, "--prompt", "hi"], {
      cwd,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const argv = JSON.parse(readFileSync(join(cwd, "argv.json"), "utf8")) as string[];
    assert.ok(argv.includes("--verbose"));
    const formatAt = argv.indexOf("--output-format");
    assert.equal(argv[formatAt + 1], "stream-json");
  });

  it("omits --verbose when the format is not stream-json", () => {
    const cwd = sandbox();
    const result = spawnSync(
      node,
      [claude, "--bin", agentEchoArgv, "--output-format", "json", "--prompt", "hi"],
      { cwd, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const argv = JSON.parse(readFileSync(join(cwd, "argv.json"), "utf8")) as string[];
    assert.ok(!argv.includes("--verbose"));
  });
});
