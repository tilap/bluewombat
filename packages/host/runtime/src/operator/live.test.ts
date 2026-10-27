import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { openFilesystemPersist } from "@bluewombat/persist-fs";
import { openWorkLedger } from "@bluewombat/work-ledger";
import { stringify as stringifyYaml } from "yaml";
import { DEFAULT_CONFIG_FILENAME } from "../config/find-config.js";
import { journalPath, openJournalFile } from "../loop/journal.js";
import { compareKeys } from "./board.js";
import { runLive } from "./live.js";

const node = process.execPath;
const here = dirname(fileURLToPath(import.meta.url));
const builder = join(here, "../../fixtures/builder-write-marker.mjs");
const gate = join(here, "../../fixtures/gate-pass.mjs");

function sandbox(): { cwd: string; ledgerRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "host-live-"));
  mkdirSync(join(root, "stable"));
  const ledgerRoot = join(root, "ledger");
  mkdirSync(ledgerRoot);
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
      workspaceRoot: "./workspaces",
      ledger: "./ledger",
      builder: {
        producer: {
          cmd: [node, builder],
          timeoutMs: 600_000,
        },
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
    assert.match(lines.join(""), /No Tickets in the ledger/);
    assert.match(lines.join(""), /Worker has not written a journal yet/);
  });

  it("shows a submitted Ticket on the board with its reference", async () => {
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
    await ledger.recordAttempt({
      key: "github:acme/app#42",
      number: 1,
      trace: { ended: "validated" },
    });
    await ledger.markIntegrating("github:acme/app#42");
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
    const parsed = JSON.parse(lines.join("")) as {
      features: unknown[];
      tickets: { key: string; state: string }[];
    };
    assert.equal(parsed.features.length, 0);
    assert.equal(parsed.tickets.length, 1);
    assert.equal(parsed.tickets[0]?.key, "fake:1");
    assert.equal(parsed.tickets[0]?.state, "received");
  });

  it("prints Features with their Tickets, in natural order, and the rest apart", async () => {
    const { cwd, ledgerRoot } = sandbox();
    const persist = await openFilesystemPersist({ root: ledgerRoot });
    const ledger = openWorkLedger({ persist });
    const ticket = (n: number, extra: { title?: string; featureTest?: boolean } = {}) =>
      ledger.admit({
        key: `fake:acme/app#${n}`,
        project: "app",
        fingerprint: "fp",
        priority: 1,
        intention: "x",
        ...extra,
      });
    const feature = (n: number) =>
      ledger.admitFeature({
        key: `fake:acme/app#${n}`,
        project: "app",
        fingerprint: "fp",
        priority: 1,
        intention: "x",
        blocked_by: [],
        merge_when_ready: false,
      });
    await ticket(107, { title: "Last of the Feature" });
    await ticket(18, { featureTest: true });
    await ticket(5);
    await feature(100);
    await ledger.openFeature({
      key: "fake:acme/app#100",
      tickets: ["fake:acme/app#107", "fake:acme/app#18"],
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
    const text = lines.join("").split("\n");
    assert.equal(text[0], "1 Feature, 3 Tickets");
    const at = (needle: string): number => text.findIndex((line) => line.includes(needle));
    assert.ok(at("#100") < at("#18") && at("#18") < at("#107") && at("#107") < at("No Feature"));
    assert.ok(at("No Feature") < at("#5"));
    assert.match(text[at("#18")] ?? "", /^├── .*#18 +received +\[feature-test\]/);
    assert.match(text[at("#107")] ?? "", /^└── .*#107 +received +Last of the Feature/);
    assert.equal(text[at("#18")]?.indexOf("received"), text[at("#100")]?.indexOf("open"));
  });

  it("orders keys by tracker then by number, and Features that need a person first", async () => {
    assert.deepEqual(["t:a#107", "t:a#18", "t:a#9", "t:0#200"].sort(compareKeys), [
      "t:0#200",
      "t:a#9",
      "t:a#18",
      "t:a#107",
    ]);
  });

  it("lists Features that need a person first and finished ones last", async () => {
    const { cwd, ledgerRoot } = sandbox();
    const persist = await openFilesystemPersist({ root: ledgerRoot });
    const ledger = openWorkLedger({ persist });
    for (const n of [1, 2, 3, 10]) {
      await ledger.admitFeature({
        key: `fake:acme/app#${n}`,
        project: "app",
        fingerprint: "fp",
        priority: 1,
        intention: "x",
        blocked_by: [],
        merge_when_ready: false,
      });
    }
    await ledger.cancelFeature("fake:acme/app#1");
    await ledger.openFeature({ key: "fake:acme/app#2", tickets: [] });
    await ledger.escalateFeature({ key: "fake:acme/app#2", kind: "assembly" });
    const lines: string[] = [];
    await runLive({
      cwd,
      argv: [],
      write: (line) => lines.push(line),
      interruptFlag: { interrupted: false },
      follow: false,
    });
    const text = lines.join("").split("\n");
    assert.equal(text[0], "4 Features, 0 Tickets");
    assert.deepEqual(
      text.filter((line) => line.startsWith("fake:")).map((line) => line.split(/\s+/)[0]),
      [2, 3, 10, 1].map((n) => `fake:acme/app#${n}`),
    );
    assert.match(text.find((line) => line.includes("#2 ")) ?? "", /escalated +assembly — waiting/);
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

  it("follows a failure with the reason the child left", async () => {
    const { cwd, ledgerRoot } = sandbox();
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
    const journal = openJournalFile(ledgerRoot, () => new Date("2026-09-23T14:09:53.000Z"));
    journal.append({
      event: "result",
      key: "github:acme/app#3",
      outcome: "unavailable",
      detail: "The tracker did not answer. Nothing was read from it.",
    });
    const deadline = Date.now() + 2_000;
    while (!lines.join("").includes("Nothing was read") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    interruptFlag.interrupted = true;
    const code = await running;
    assert.equal(code, 0);
    assert.match(lines.join(""), /Nothing was read/);
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
