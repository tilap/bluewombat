import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { childEnv, runChild } from "./run-child.js";

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

const FRENCH = { LC_ALL: "fr_FR.UTF-8", LANG: "fr_FR.UTF-8", LANGUAGE: "fr" };

describe("runChild", () => {
  it("has git speak C whatever the caller asked for", async () => {
    // A failed Isolation or fold carries git's words into a report. Seen in
    // French on a French machine. Without a French locale installed, git is in
    // English anyway and this proves nothing there.
    const into = join(mkdtempSync(join(tmpdir(), "run-child-")), "never");
    const outcome = await runChild({
      argv: ["git", "clone", "-q", "/nonexistent/repository.git", into],
      timeoutMs: 30_000,
      timeoutClock: "isolation",
      shouldInterrupt: () => false,
      envOverrides: FRENCH,
    });
    assert.ok(outcome.kind === "exited", JSON.stringify(outcome));
    assert.match(outcome.stderr, /does not exist/);
    assert.doesNotMatch(outcome.stderr, /n'existe pas/);
  });

  it("keeps everything else it was handed", () => {
    const base = { timeoutMs: 1, timeoutClock: "isolation" as const, shouldInterrupt: () => false };
    assert.deepEqual(
      childEnv({ ...base, argv: [], env: { PATH: "/bin", GIT_AUTHOR_NAME: "mason" } }),
      { PATH: "/bin", GIT_AUTHOR_NAME: "mason", LC_ALL: "C" },
    );
    const layered = childEnv({ ...base, argv: [], envOverrides: { GIT_INDEX_FILE: "/tmp/i" } });
    assert.equal(layered.GIT_INDEX_FILE, "/tmp/i");
    assert.equal(layered.LC_ALL, "C");
    assert.equal(layered.PATH, process.env.PATH);
  });

  it("a timeout ends the whole tree at the ceiling, not when a grandchild lets go", async () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), "run-child-")), "grandchild.pid");
    const started = Date.now();
    const outcome = await runChild({
      argv: [process.execPath, "-e", SPAWNS_GRANDCHILD, pidFile],
      timeoutMs: 3_000,
      timeoutClock: "isolation",
      shouldInterrupt: () => false,
    });
    assert.equal(outcome.kind, "timed_out");
    assert.ok(Date.now() - started < 15_000, "the outcome must not wait for the grandchild");
    assert.ok(await waitDead(Number(readFileSync(pidFile, "utf8")), 5_000));
  });
});
