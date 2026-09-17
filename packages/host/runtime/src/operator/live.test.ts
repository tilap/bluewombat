import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { openFilesystemPersist } from "@bluewombat/persist-fs";
import { openWorkLedger } from "@bluewombat/work-ledger";
import { CONFIG_FILENAME } from "../config/find-config.js";
import { journalPath, openJournalFile } from "../loop/journal.js";
import { runLive } from "./live.js";

const node = process.execPath;
const here = dirname(fileURLToPath(import.meta.url));
const planner = join(here, "../../fixtures/planner-one-subtask.mjs");
const builder = join(here, "../../fixtures/builder-write-marker.mjs");
const gate = join(here, "../../fixtures/gate-pass.mjs");

function sandbox(): { cwd: string; ledgerRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "host-live-"));
  mkdirSync(join(root, "stable"));
  const ledgerRoot = join(root, "ledger");
  mkdirSync(ledgerRoot);
  writeFileSync(
    join(root, CONFIG_FILENAME),
    JSON.stringify({
      manager: "@bluewombat/manager-fake",
      managerOptions: { source: "./source", target: "./threads" },
      workLine: { stable: "./stable", isolation: "@bluewombat/isolation-copy" },
      workspaceRoot: "./workspaces",
      ledger: "./ledger",
      planner: { cmd: [node, planner], timeoutMs: 600_000 },
      builder: {
        producer: { cmd: [node, builder], timeoutMs: 600_000 },
        repair: { cmd: [node, builder], timeoutMs: 600_000 },
        gates: { gates: [{ id: "check", argv: [node, gate], timeoutMs: 10_000 }] },
      },
      timeoutMs: 1000,
    }),
  );
  return { cwd: root, ledgerRoot };
}

describe("runLive", () => {
  it("prints an empty snapshot and does not fail when the journal is missing", async () => {
    const { cwd } = sandbox();
    const lines: string[] = [];
    const code = await runLive({
      cwd,
      argv: [],
      write: (line) => lines.push(line),
      interruptFlag: { interrupted: true },
      follow: true,
      pollMs: 20,
    });
    assert.equal(code, 0);
    assert.match(lines.join(""), /No Features in the ledger/);
    assert.match(lines.join(""), /Worker has not written a journal yet/);
  });

  it("shows a submitted Feature on the board with its reference", async () => {
    const { cwd, ledgerRoot } = sandbox();
    const persist = await openFilesystemPersist({ root: ledgerRoot });
    const ledger = openWorkLedger({ persist });
    await ledger.admit({
      key: "github:acme/app#42",
      project: "app",
      fingerprint: "fp",
      priority: 50,
      intention: "ship it",
    });
    await ledger.claim("app");
    await ledger.recordPlan({
      key: "github:acme/app#42",
      plannedAt: "2026-09-07T00:00:00.000Z",
      subtasks: [{ id: "A", intention: "ship it", definition_of_done: "done", depends_on: [] }],
    });
    await ledger.startSubtask({ key: "github:acme/app#42", subtaskId: "A" });
    await ledger.recordAttempt({
      key: "github:acme/app#42",
      subtaskId: "A",
      number: 1,
      trace: { ended: "validated" },
    });
    await ledger.markSubtaskIntegrated({ key: "github:acme/app#42", subtaskId: "A" });
    await ledger.markSubmitted({
      key: "github:acme/app#42",
      reference: "https://example.test/pr/7",
    });
    const lines: string[] = [];
    const code = await runLive({
      cwd,
      argv: [],
      write: (line) => lines.push(line),
      interruptFlag: { interrupted: false },
      follow: false,
    });
    assert.equal(code, 0);
    assert.match(lines.join(""), /github:acme\/app#42/);
    assert.match(lines.join(""), /submitted/);
    assert.match(lines.join(""), /https:\/\/example.test\/pr\/7/);
  });

  it("status --json is a snapshot then exit", async () => {
    const { cwd, ledgerRoot } = sandbox();
    const persist = await openFilesystemPersist({ root: ledgerRoot });
    const ledger = openWorkLedger({ persist });
    await ledger.admit({
      key: "fake:1",
      project: "proj",
      fingerprint: "fp",
      priority: 1,
      intention: "x",
    });
    const lines: string[] = [];
    const code = await runLive({
      cwd,
      argv: ["--json"],
      write: (line) => lines.push(line),
      interruptFlag: { interrupted: false },
      follow: false,
    });
    assert.equal(code, 0);
    const parsed = JSON.parse(lines.join("")) as { key: string; state: string }[];
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]?.key, "fake:1");
    assert.equal(parsed[0]?.state, "received");
  });

  it("follows new journal lines after the snapshot", async () => {
    const { cwd, ledgerRoot } = sandbox();
    const journal = openJournalFile(ledgerRoot, () => new Date("2026-09-07T19:12:01.000Z"));
    journal.append({ event: "listen", deliveries: 0 });
    const lines: string[] = [];
    const interruptFlag = { interrupted: false };
    const running = runLive({
      cwd,
      argv: [],
      write: (line) => lines.push(line),
      interruptFlag,
      follow: true,
      pollMs: 30,
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    journal.append({ event: "status", key: "fake:42", label: "gating:ci-green:attempt-1:1" });
    const deadline = Date.now() + 2_000;
    while (!lines.join("").includes("gating:ci-green:attempt-1:1") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    interruptFlag.interrupted = true;
    const code = await running;
    assert.equal(code, 0);
    assert.match(lines.join(""), /gating:ci-green:attempt-1:1/);
    assert.equal(existsSyncSafe(journalPath(ledgerRoot)), true);
  });

  it("exits 2 when the config cannot be opened", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "host-live-missing-"));
    const lines: string[] = [];
    const code = await runLive({
      cwd,
      argv: [],
      write: (line) => lines.push(line),
      interruptFlag: { interrupted: false },
      follow: false,
    });
    assert.equal(code, 2);
    assert.match(lines.join(""), /Missing required/);
  });
});

function existsSyncSafe(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}
