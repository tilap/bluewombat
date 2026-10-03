import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readFetchStdout, runFetch } from "./run-fetch.js";

// A command that starts a grandchild sharing its pipes, then waits: what a
// plain kill of the command leaves running.
const SPAWNS_GRANDCHILD = `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "inherit" });
writeFileSync(process.argv[1], String(grandchild.pid));
setTimeout(() => {}, 60000);
`;

async function waitDead(pid: number, ms: number): Promise<boolean> {
  const alive = (): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const until = Date.now() + ms;
  while (Date.now() < until && alive()) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !alive();
}

describe("readFetchStdout", () => {
  it("merges a JSON object", () => {
    const result = readFetchStdout('{"project":"reporting"}\n');
    assert.equal(result.kind, "merged");
    assert.deepEqual(result.kind === "merged" && result.object, { project: "reporting" });
  });

  it("treats empty stdout as nothing to merge", () => {
    assert.equal(readFetchStdout("   \n").kind, "empty");
  });

  it("treats anything else as unavailable", () => {
    for (const stdout of ["<html>", "[1,2]", '"text"', "null"]) {
      assert.equal(readFetchStdout(stdout).kind, "unavailable", stdout);
    }
  });
});

describe("runFetch", () => {
  it("a Fetch over its ceiling is unavailable, and takes its whole tree with it", async () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), "run-fetch-")), "grandchild.pid");
    const started = Date.now();
    const result = await runFetch({
      argv: [process.execPath, "-e", SPAWNS_GRANDCHILD, pidFile],
      timeoutMs: 3_000,
      shouldInterrupt: () => false,
    });
    assert.equal(result.kind, "unavailable");
    assert.ok(Date.now() - started < 15_000, "the outcome must not wait for the grandchild");
    assert.ok(await waitDead(Number(readFileSync(pidFile, "utf8")), 5_000));
  });
});
