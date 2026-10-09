import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { stringify as stringifyYaml } from "yaml";
import { CONFIG_FILENAME } from "../config/find-config.js";
import { openHost } from "../loop/open-host.js";
import { runRelease } from "./release.js";

const node = process.execPath;
const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "../../fixtures");
const planner = join(fixtures, "planner-one-subtask.mjs");
const builder = join(fixtures, "builder-write-marker.mjs");

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), "host-release-"));
  mkdirSync(join(root, "stable"));
  mkdirSync(join(root, "source"));
  writeFileSync(join(root, "stable", "seed.txt"), "already good\n");
  writeFileSync(
    join(root, CONFIG_FILENAME),
    stringifyYaml({
      manager: "@bluewombat/manager-fake",
      managerOptions: { source: "./source", target: "./threads" },
      workLine: { stable: "./stable", isolation: "@bluewombat/isolation-copy" },
      workspaceRoot: "./.mason/workspaces",
      ledger: "./.mason/ledger",
      planner: { cmd: [node, planner], timeoutMs: 30_000 },
      builder: {
        producer: { cmd: [node, builder], timeoutMs: 30_000, gates: { gates: [] } },
        repair: { cmd: [node, builder], timeoutMs: 30_000 },
      },
      timeoutMs: 30_000,
    }),
  );
  return root;
}

async function releaseIn(cwd: string, argv: string[]) {
  const lines: string[] = [];
  const code = await runRelease({
    cwd,
    argv,
    write: (line) => lines.push(line),
  });
  return { code, output: lines.join("") };
}

describe("runRelease", () => {
  it("refuses a missing key", async () => {
    const { code, output } = await releaseIn(sandbox(), []);
    assert.equal(code, 2);
    assert.match(output, /release <key>/);
  });

  it("refuses a key the ledger does not know", async () => {
    const { code, output } = await releaseIn(sandbox(), ["fake:99"]);
    assert.equal(code, 2);
    assert.match(output, /No Feature named "fake:99"/);
  });

  it("releases a held Subtask by key", async () => {
    const cwd = sandbox();
    const host = await openHost({
      manager: "@bluewombat/manager-fake",
      managerOptions: {
        source: join(cwd, "source"),
        target: join(cwd, "threads"),
      },
      workLineStable: join(cwd, "stable"),
      workLineIsolation: "@bluewombat/isolation-copy",
      workspaceRoot: join(cwd, ".mason/workspaces"),
      ledgerRoot: join(cwd, ".mason/ledger"),
      planner: { cmd: [node, planner], timeoutMs: 30_000, gates: [] },
      builder: {
        producer: { cmd: [node, builder], timeoutMs: 30_000, gates: [] },
        repair: { cmd: [node, builder], timeoutMs: 30_000, gates: [] },
      },
      assembly: { gates: [] },
      timeoutMs: 30_000,
    });
    await host.ledger.admit({
      key: "fake:42",
      project: "proj",
      fingerprint: "fp-1",
      priority: 50,
      intention: "deliver the marker file",
    });
    await host.ledger.claim("proj");
    await host.ledger.recordPlan({
      key: "fake:42",
      plannedAt: "2026-01-01T00:00:00.000Z",
      subtasks: [
        {
          id: "A",
          intention: "first",
          definition_of_done: "A done",
          depends_on: [],
        },
      ],
    });
    await host.ledger.startSubtask({ key: "fake:42", subtaskId: "A" });
    await host.ledger.declareWorkspace({
      key: "fake:42",
      feature: join(cwd, ".mason/workspaces/fake-42/feature"),
      subtask: join(cwd, ".mason/workspaces/fake-42/subtask-A"),
    });
    await host.close();

    const { code, output } = await releaseIn(cwd, ["fake:42"]);
    assert.equal(code, 0);
    assert.match(output, /Released fake:42/);

    const check = await openHost({
      manager: "@bluewombat/manager-fake",
      managerOptions: {
        source: join(cwd, "source"),
        target: join(cwd, "threads"),
      },
      workLineStable: join(cwd, "stable"),
      workLineIsolation: "@bluewombat/isolation-copy",
      workspaceRoot: join(cwd, ".mason/workspaces"),
      ledgerRoot: join(cwd, ".mason/ledger"),
      planner: { cmd: [node, planner], timeoutMs: 30_000, gates: [] },
      builder: {
        producer: { cmd: [node, builder], timeoutMs: 30_000, gates: [] },
        repair: { cmd: [node, builder], timeoutMs: 30_000, gates: [] },
      },
      assembly: { gates: [] },
      timeoutMs: 30_000,
    });
    const got = await check.ledger.get("fake:42");
    assert.ok(got.ok);
    assert.equal(got.aggregate.plan?.subtasks.find((st) => st.id === "A")?.state, "runnable");
    assert.equal(got.aggregate.bail, undefined);
    await check.close();
  });

  it("refuses integrating", async () => {
    const cwd = sandbox();
    const host = await openHost({
      manager: "@bluewombat/manager-fake",
      managerOptions: {
        source: join(cwd, "source"),
        target: join(cwd, "threads"),
      },
      workLineStable: join(cwd, "stable"),
      workLineIsolation: "@bluewombat/isolation-copy",
      workspaceRoot: join(cwd, ".mason/workspaces"),
      ledgerRoot: join(cwd, ".mason/ledger"),
      planner: { cmd: [node, planner], timeoutMs: 30_000, gates: [] },
      builder: {
        producer: { cmd: [node, builder], timeoutMs: 30_000, gates: [] },
        repair: { cmd: [node, builder], timeoutMs: 30_000, gates: [] },
      },
      assembly: { gates: [] },
      timeoutMs: 30_000,
    });
    await host.ledger.admit({
      key: "fake:42",
      project: "proj",
      fingerprint: "fp-1",
      priority: 50,
      intention: "deliver the marker file",
    });
    await host.ledger.claim("proj");
    await host.ledger.recordPlan({
      key: "fake:42",
      plannedAt: "2026-01-01T00:00:00.000Z",
      subtasks: [
        {
          id: "A",
          intention: "first",
          definition_of_done: "A done",
          depends_on: [],
        },
      ],
    });
    await host.ledger.startSubtask({ key: "fake:42", subtaskId: "A" });
    await host.ledger.recordAttempt({
      key: "fake:42",
      subtaskId: "A",
      number: 1,
      trace: { ended: "validated" },
    });
    await host.ledger.markSubtaskIntegrated({ key: "fake:42", subtaskId: "A" });
    await host.close();

    const { code, output } = await releaseIn(cwd, ["fake:42"]);
    assert.equal(code, 1);
    assert.match(output, /integrating/);
  });
});
