import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { childEnv, runChild } from "./run-child.js";

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
});
