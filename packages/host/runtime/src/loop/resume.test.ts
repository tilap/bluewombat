import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { GateSpec } from "@bluewombat/implementer";
import type { HostOptions } from "../config/types.js";
import { openHost } from "./open-host.js";

// The runs that matter to an unattended Mason, end to end through the Host: a producer killed
// at its clock after it delivered, and a run stopped in the middle of a unit then started again.

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures");
const node = process.execPath;
const MARKER = "work done\n";

type Paths = { source: string; target: string; stable: string; workspaces: string; ledger: string };

function sandbox(): Paths {
  const root = mkdtempSync(join(tmpdir(), "host-resume-"));
  const stable = join(root, "stable");
  mkdirSync(stable);
  writeFileSync(join(stable, "seed.txt"), "already good\n");
  const source = join(root, "source");
  const target = join(root, "threads");
  mkdirSync(source);
  mkdirSync(target);
  writeFileSync(
    join(source, "0001-create.json"),
    JSON.stringify({
      id: "F1",
      project: "proj",
      intention: "a feature",
      priority: 75,
      tickets: [{ id: "42", intention: "deliver the marker file" }],
    }),
  );
  return {
    source,
    target,
    stable,
    workspaces: join(root, "workspaces"),
    ledger: join(root, "ledger"),
  };
}

const passing = (): GateSpec[] => [
  { id: "check", argv: [node, join(fixtures, "gate-pass.mjs")], timeoutMs: 10_000 },
];

const producer = (mode: string): string[] => [
  node,
  join(fixtures, "builder-resume-probe.mjs"),
  mode,
];

async function hostFor(paths: Paths, mode: string, over: Partial<HostOptions> = {}, ms = 30_000) {
  const manager = {
    package: "@bluewombat/manager-fake",
    options: { source: paths.source, target: paths.target },
  };
  return await openHost({
    ...over,
    featureTracker: manager,
    ticketTracker: manager,
    workLineStable: paths.stable,
    workLineIsolation: "@bluewombat/isolation-copy",
    workspaceRoot: paths.workspaces,
    ledgerRoot: paths.ledger,
    builder: {
      producer: { cmd: producer(mode), timeoutMs: ms, gates: passing() },
      repair: { cmd: producer(mode), timeoutMs: ms, gates: passing() },
    },
    ticket: { gates: [] },
    timeoutMs: 30_000,
  });
}

function journal(paths: Paths): Record<string, unknown>[] {
  return readFileSync(join(paths.ledger, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("the Host with a producer that overruns, and with a run that is stopped", () => {
  it("e1. a producer killed at its clock after it delivered is judged by the Gates, and the ticket lands", async () => {
    const paths = sandbox();
    const host = await hostFor(paths, "write-then-hang", {}, 700);
    const tick = await host.runOnce();
    await host.close();

    assert.equal(tick.lastRun?.outcome, "done");
    assert.equal(readFileSync(join(paths.stable, "delivered.txt"), "utf8"), MARKER);
    const lines = journal(paths);
    const built = lines.filter((line) => line.event === "builder-finished");
    assert.equal(built.length, 1, "one Attempt was enough");
    assert.equal((built[0] as { result: { kind: string } }).result.kind, "timed_out");
    const ended = lines.filter((line) => line.event === "attempt-finished" && line.attempt === 1);
    assert.equal(ended.at(-1)?.ended, "validated");
  });

  it("e2. a run stopped mid-unit leaves its workspace, and the next run picks it up and finishes", async () => {
    const paths = sandbox();
    const flag = { interrupted: false };
    const first = await hostFor(paths, "hang-after-half", { interruptFlag: flag });
    const pending = first.runOnce();
    // The producer wrote half of the work and waits: this is the moment Mason is stopped.
    for (let i = 0; i < 200 && !readdirSync(paths.workspaces).length; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
    flag.interrupted = true;
    const stopped = await pending;
    await first.close();
    assert.notEqual(stopped.lastRun?.outcome, "done");

    const second = await hostFor(paths, "finish");
    const tick = await second.runOnce();
    await second.close();
    assert.equal(tick.lastRun?.outcome, "done");
    assert.equal(readFileSync(join(paths.stable, "delivered.txt"), "utf8"), MARKER);

    const lines = journal(paths);
    assert.equal(
      lines.filter((line) => line.event === "isolation-started").length,
      1,
      "the workspace was picked up, not made again",
    );
    // What the second producer found in its workspace, and was told.
    assert.equal(readFileSync(join(paths.stable, "found-half.txt"), "utf8"), "half of the work\n");
    const told = JSON.parse(readFileSync(join(paths.stable, "told.json"), "utf8")) as string[];
    assert.match(told[told.indexOf("--report") + 1] ?? "", /stopped before it finished/);
  });
});
