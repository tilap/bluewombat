import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runChild } from "./run-child.js";

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

describe("runChild", () => {
  it("a timeout ends the whole tree at the ceiling, not when a grandchild lets go", async () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), "run-child-")), "grandchild.pid");
    const started = Date.now();
    const outcome = await runChild({
      argv: [process.execPath, "-e", SPAWNS_GRANDCHILD, pidFile],
      timeoutMs: 3_000,
      timeoutClock: "planner",
      shouldInterrupt: () => false,
    });
    assert.equal(outcome.kind, "timed_out");
    assert.ok(Date.now() - started < 15_000, "the outcome must not wait for the grandchild");
    assert.ok(await waitDead(Number(readFileSync(pidFile, "utf8")), 5_000));
  });

  it("a child that ends by itself is not touched", async () => {
    const outcome = await runChild({
      argv: [process.execPath, "-e", "console.log('ok')"],
      timeoutMs: 5_000,
      timeoutClock: "planner",
      shouldInterrupt: () => false,
    });
    assert.equal(outcome.kind, "exited");
  });
});
