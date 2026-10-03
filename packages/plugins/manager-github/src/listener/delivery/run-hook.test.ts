import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runHook } from "./run-hook.js";

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

describe("runHook", () => {
  it("a hook over its cap takes its whole tree with it", async () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), "run-hook-")), "grandchild.pid");
    await runHook([process.execPath, "-e", SPAWNS_GRANDCHILD, pidFile], undefined);
    assert.ok(await waitDead(Number(readFileSync(pidFile, "utf8")), 5_000));
  });

  it("a missing command changes nothing", async () => {
    await runHook(["/no/such/command"], undefined);
    await runHook([], undefined);
  });
});
