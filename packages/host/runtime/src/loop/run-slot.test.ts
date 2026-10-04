import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runSlot } from "./run-slot.js";

// A slot that starts a grandchild sharing its pipes, then waits.
const SPAWNS_GRANDCHILD = `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "inherit" });
writeFileSync(process.argv[1], String(grandchild.pid));
setTimeout(() => {}, 60000);
`;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDead(pid: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until && alive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !alive(pid);
}

describe("runSlot", () => {
  it("answers what the slot wrote", async () => {
    const run = await runSlot({
      command: process.execPath,
      args: ["-e", 'console.log("{}"); console.error("note")'],
      timeoutMs: 5_000,
    });
    assert.equal(run.error, undefined);
    assert.equal(run.status, 0);
    assert.equal(run.stdout.trim(), "{}");
    assert.equal(run.stderr.trim(), "note");
  });

  it("ends the whole tree at the ceiling, not when a grandchild lets go", async () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), "run-slot-")), "grandchild.pid");
    const started = Date.now();
    const run = await runSlot({
      command: process.execPath,
      args: ["-e", SPAWNS_GRANDCHILD, pidFile],
      timeoutMs: 3_000,
    });
    assert.match(run.error?.message ?? "", /killed after 3000ms/);
    assert.ok(Date.now() - started < 15_000, "the outcome must not wait for the grandchild");
    assert.ok(await waitDead(Number(readFileSync(pidFile, "utf8")), 5_000));
  });

  it("says why a slot could not start", async () => {
    const run = await runSlot({ command: "/no/such/command", args: [], timeoutMs: 1_000 });
    assert.ok(run.error);
    assert.equal(run.status, null);
  });
});
