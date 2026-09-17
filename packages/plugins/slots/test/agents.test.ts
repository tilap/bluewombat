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
const fixtures = join(here, "../fixtures");
const agentEchoArgv = join(fixtures, "agent-echo-argv.mjs");

function sandbox() {
  return mkdtempSync(join(tmpdir(), "mason-agent-"));
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
    const last = result.stdout.trim().split("\n").filter(Boolean).at(-1);
    assert.ok(last !== undefined);
    const payload = JSON.parse(last) as { name: string; code: number };
    assert.equal(payload.name, "Cursor CLI");
    assert.equal(payload.code, 0);
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
