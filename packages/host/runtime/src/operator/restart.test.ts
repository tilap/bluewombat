import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { openFilesystemPersist } from "@bluewombat/persist-fs";
import { openWorkLedger } from "@bluewombat/work-ledger";
import { DEFAULT_CONFIG_FILENAME } from "../config/find-config.js";
import { fixtureYaml as stringifyYaml } from "../config/fixture-yaml.js";
import { runRestart } from "./restart.js";

const node = process.execPath;
const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "../../fixtures");
const builder = join(fixtures, "builder-write-marker.mjs");
const gate = join(fixtures, "gate-pass.mjs");

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), "host-restart-"));
  mkdirSync(join(root, "stable"));
  mkdirSync(join(root, "source"));
  writeFileSync(join(root, "stable", "seed.txt"), "already good\n");
  writeFileSync(
    join(root, DEFAULT_CONFIG_FILENAME),
    stringifyYaml({
      featureTracker: {
        package: "@bluewombat/manager-fake",
        options: { source: "./source", target: "./threads" },
      },
      ticketTracker: {
        package: "@bluewombat/manager-fake",
        options: { source: "./source", target: "./threads" },
      },
      workLine: { stable: "./stable", isolation: "@bluewombat/isolation-copy" },
      workspaceRoot: "./.mason/workspaces",
      ledger: "./.mason/ledger",
      builder: {
        producer: { cmd: [node, builder], timeoutMs: 30_000 },
        repair: { cmd: [node, builder], timeoutMs: 30_000 },
        gates: { gates: [{ id: "check", argv: [node, gate], timeoutMs: 10_000 }] },
      },
      timeoutMs: 30_000,
    }),
  );
  return root;
}

async function ledgerOf(cwd: string) {
  return openWorkLedger({
    persist: await openFilesystemPersist({ root: join(cwd, ".mason/ledger") }),
  });
}

/** An open Feature `fake:o/r#1`, escalated when asked. */
async function seed(cwd: string, escalated: boolean): Promise<void> {
  const ledger = await ledgerOf(cwd);
  await ledger.admitFeature({
    key: "fake:o/r#1",
    project: "proj",
    fingerprint: "f",
    priority: 50,
    intention: "deliver it",
    blocked_by: [],
    merge_when_ready: false,
  });
  await ledger.admit({
    key: "fake:o/r#42",
    project: "proj",
    fingerprint: "f",
    priority: 50,
    intention: "a ticket",
    feature: "fake:o/r#1",
  });
  await ledger.openFeature({ key: "fake:o/r#1", tickets: ["fake:o/r#42"] });
  if (escalated) {
    await ledger.escalateFeature({ key: "fake:o/r#1", report: "the line was refused" });
  }
}

async function restartIn(cwd: string, argv: string[]) {
  const lines: string[] = [];
  const code = await runRestart({ cwd, argv, write: (line) => lines.push(line) });
  return { code, output: lines.join("") };
}

describe("runRestart", () => {
  it("refuses a missing key", async () => {
    const { code, output } = await restartIn(sandbox(), []);
    assert.equal(code, 2);
    assert.match(output, /restart <feature-key>/);
  });

  it("refuses a key the ledger does not know", async () => {
    const { code, output } = await restartIn(sandbox(), ["fake:o/r#9"]);
    assert.equal(code, 2);
    assert.match(output, /No Ticket or Feature matches/);
  });

  it("refuses a Ticket", async () => {
    const cwd = sandbox();
    await seed(cwd, true);
    const { code, output } = await restartIn(cwd, ["fake:o/r#42"]);
    assert.equal(code, 2);
    assert.match(output, /is a Ticket/);
  });

  it("refuses a Feature that is not escalated, and leaves it as it was", async () => {
    const cwd = sandbox();
    await seed(cwd, false);
    const { code, output } = await restartIn(cwd, ["fake:o/r#1"]);
    assert.equal(code, 1);
    assert.match(output, /is open: only an escalated Feature restarts/);
    const got = await (await ledgerOf(cwd)).getFeature("fake:o/r#1");
    assert.ok(got.ok);
    assert.equal(got.aggregate.state, "open");
    assert.equal(got.aggregate.resumes, 0);
  });

  it("resumes an escalated Feature, by its number as well as its key", async () => {
    const cwd = sandbox();
    await seed(cwd, true);
    const { code, output } = await restartIn(cwd, ["#1"]);
    assert.equal(code, 0);
    assert.match(output, /Restarted fake:o\/r#1/);
    const got = await (await ledgerOf(cwd)).getFeature("fake:o/r#1");
    assert.ok(got.ok);
    assert.equal(got.aggregate.state, "open");
    assert.equal(got.aggregate.resumes, 1);
  });
});
