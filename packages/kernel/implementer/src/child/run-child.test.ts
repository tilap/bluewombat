import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { runChild } from "./run-child.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures");

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
  while (Date.now() < until) {
    if (!alive(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !alive(pid);
}

describe("runChild", () => {
  it("a timeout ends the whole tree at the ceiling, not when a grandchild lets go", async () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), "run-child-")), "grandchild.pid");
    const started = Date.now();
    const outcome = await runChild({
      argv: [process.execPath, join(fixtures, "spawns-grandchild.mjs"), pidFile],
      timeoutMs: 500,
      shouldInterrupt: () => false,
    });
    assert.equal(outcome.kind, "timed_out");
    assert.ok(Date.now() - started < 5_000, "the outcome must not wait for the grandchild");
    assert.ok(existsSync(pidFile));
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(await waitDead(pid, 2_000), "the grandchild must be killed with its parent");
  });

  it("an interrupt ends the whole tree", async () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), "run-child-")), "grandchild.pid");
    let stop = false;
    const outcome = runChild({
      argv: [process.execPath, join(fixtures, "spawns-grandchild.mjs"), pidFile],
      timeoutMs: 30_000,
      shouldInterrupt: () => stop,
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    stop = true;
    assert.equal((await outcome).kind, "interrupted");
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(await waitDead(pid, 2_000), "the grandchild must be killed with its parent");
  });

  it("a child that ends by itself is not touched", async () => {
    const outcome = await runChild({
      argv: [process.execPath, "-e", "console.log('ok')"],
      timeoutMs: 5_000,
      shouldInterrupt: () => false,
    });
    assert.equal(outcome.kind, "exited");
    if (outcome.kind === "exited") {
      assert.equal(outcome.exitCode, 0);
      assert.match(outcome.stdout, /ok/);
    }
  });
});
