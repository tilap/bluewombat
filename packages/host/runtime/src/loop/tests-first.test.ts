import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { strategy } from "@bluewombat/isolation-git";
import { createTransformers } from "./transformers.js";

/**
 * The tests written first, end to end on a real git work line: their own agent
 * and Gates, the checkpoint that commits them, and the producer's Gates that keep
 * them as they were. Real Gates (`tests-red`, `tests-frozen`), real git, and
 * agents that are small scripts.
 */

const node = process.execPath;
const gates = join(dirname(fileURLToPath(import.meta.url)), "../../../../plugins/slots/gates");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

function rig(options: { redCmd: string; producer: string }) {
  const root = mkdtempSync(join(tmpdir(), "tests-first-"));
  const stable = join(root, "stable");
  mkdirSync(stable);
  execFileSync("git", ["init", "-q", "-b", "main", stable]);
  git(stable, "config", "user.email", "t@test.local");
  git(stable, "config", "user.name", "Test");
  git(stable, "config", "commit.gpgsign", "false");
  writeFileSync(join(stable, "code.txt"), "base\n");
  git(stable, "add", "-A");
  git(stable, "commit", "-qm", "init");

  const script = (name: string, body: string): string[] => {
    const path = join(root, `${name}.mjs`);
    writeFileSync(path, `import { writeFileSync, readFileSync } from "node:fs";\n${body}\n`);
    return [node, path];
  };
  const transformers = createTransformers({
    builder: {
      tests: {
        cmd: script("writes-tests", 'writeFileSync("a.test.ts", "test of the case\\n");'),
        timeoutMs: 20_000,
        gates: [
          {
            id: "tests-red",
            argv: [node, join(gates, "tests-red.mjs"), "--cmd", options.redCmd],
            timeoutMs: 20_000,
          },
        ],
      },
      producer: {
        cmd: script("producer", options.producer),
        timeoutMs: 20_000,
        gates: [
          { id: "tests-frozen", argv: [node, join(gates, "tests-frozen.mjs")], timeoutMs: 20_000 },
        ],
      },
      repair: { cmd: script("repair", ""), timeoutMs: 20_000, gates: [] },
      maxAttempts: 1,
    },
    ticket: { gates: [] },
    isolation: strategy.isolation,
    fold: strategy.fold,
    timeoutMs: 20_000,
  });
  return { root, stable, transformers };
}

async function writeTestsFirst(r: ReturnType<typeof rig>) {
  const ws = join(r.root, "ws");
  const isolated = await r.transformers.isolate({
    id: "github:o/r#1",
    parent: r.stable,
    child: ws,
    durationMs: 30_000,
  });
  assert.equal(isolated.outcome, "isolated");
  const written = await r.transformers.implement({
    id: "t:tests",
    stage: "tests",
    produce: true,
    intention: "Add the thing",
    workspace: ws,
  });
  return { ws, written };
}

async function checkpoint(r: ReturnType<typeof rig>, ws: string) {
  return await r.transformers.integrate({
    id: "t:tests",
    parent: ws,
    child: ws,
    durationMs: 30_000,
    subject: "Tests: Add the thing",
  });
}

describe("the tests written first, on a real git work line", () => {
  it("writes them red, commits them, and lets a producer that leaves them alone through", async () => {
    const r = rig({
      redCmd: "echo 'AssertionError: expected 1 to be 2'; exit 1",
      producer: 'writeFileSync("code.txt", "the behaviour\\n");',
    });
    const { ws, written } = await writeTestsFirst(r);
    assert.equal(written.outcome, "validated");
    assert.equal((await checkpoint(r, ws)).outcome, "integrated");
    assert.equal(git(ws, "log", "-1", "--format=%s").trim(), "Tests: Add the thing");
    assert.equal(
      git(ws, "status", "--porcelain"),
      "",
      "the tests are committed, nothing is left over",
    );

    const made = await r.transformers.implement({ id: "t", intention: "i", workspace: ws });
    assert.equal(made.outcome, "validated", JSON.stringify(made.traces));
    assert.equal(readFileSync(join(ws, "code.txt"), "utf8"), "the behaviour\n");
  });

  it("refuses a producer that edits the tests until they pass", async () => {
    const r = rig({
      redCmd: "echo 'AssertionError'; exit 1",
      producer: 'writeFileSync("a.test.ts", "edited to pass\\n");',
    });
    const { ws } = await writeTestsFirst(r);
    assert.equal((await checkpoint(r, ws)).outcome, "integrated");
    const made = await r.transformers.implement({ id: "t", intention: "i", workspace: ws });
    assert.equal(made.outcome, "escalated");
    assert.equal(made.traces[0]?.refusedBy, "tests-frozen");
    assert.match(made.traces[0]?.report ?? "", /a\.test\.ts/);
  });

  it("refuses tests that already pass, so nothing is committed on them", async () => {
    const r = rig({ redCmd: "exit 0", producer: "" });
    const { written } = await writeTestsFirst(r);
    assert.equal(written.outcome, "escalated");
    assert.equal(written.traces[0]?.refusedBy, "tests-red");
    assert.match(written.traces[0]?.report ?? "", /test nothing that is missing/);
  });
});
