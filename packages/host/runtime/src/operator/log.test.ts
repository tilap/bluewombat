import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { CONFIG_FILENAME } from "../config/find-config.js";
import { openJournalFile } from "../loop/journal.js";
import { runLog } from "./log.js";

const node = process.execPath;
const here = dirname(fileURLToPath(import.meta.url));
const planner = join(here, "../../fixtures/planner-one-subtask.mjs");
const builder = join(here, "../../fixtures/builder-write-marker.mjs");
const gate = join(here, "../../fixtures/gate-pass.mjs");

function sandbox(): { cwd: string; ledgerRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "host-log-"));
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

function film(ledgerRoot: string): void {
  const journal = openJournalFile(ledgerRoot, () => new Date("2026-09-23T14:09:53.000Z"));
  journal.append({ event: "idle" });
  journal.append({ event: "listen", outcome: "completed", deliveries: 0 });
  journal.append({ event: "listen", outcome: "completed", deliveries: 1 });
  journal.append({
    event: "planner-finished",
    kind: "exited",
    exitCode: 1,
    key: "github:acme/app#3",
  });
  journal.append({
    event: "result",
    outcome: "unavailable",
    detail: "The Planner exited without answering.",
    key: "github:acme/app#3",
  });
  journal.append({ event: "ran", key: "github:acme/app#3", outcome: "refused", state: "planning" });
}

describe("runLog", () => {
  it("says when the journal has not been written", async () => {
    const { cwd } = sandbox();
    const lines: string[] = [];
    const code = await runLog({ cwd, argv: [], write: (line) => lines.push(line) });
    assert.equal(code, 0);
    assert.match(lines.join(""), /No journal/);
  });

  it("prints the reason and hides quiet polls", async () => {
    const { cwd, ledgerRoot } = sandbox();
    film(ledgerRoot);
    const lines: string[] = [];
    const code = await runLog({ cwd, argv: [], write: (line) => lines.push(line) });
    assert.equal(code, 0);
    const text = lines.join("");
    assert.match(text, /The Planner exited without answering/);
    assert.match(text, /planner exited {2}exit 1|planner-finished/);
    assert.match(text, /exit 1/);
    assert.doesNotMatch(text, /\bidle\b/);
    assert.match(text, /quiet lines hidden/);
    assert.match(
      text,
      /unavailable {2}The Planner exited without answering\. {2}×1|unavailable {2}The Planner exited without answering\./,
    );
  });

  it("--problems keeps the failure and drops the listen", async () => {
    const { cwd, ledgerRoot } = sandbox();
    film(ledgerRoot);
    const lines: string[] = [];
    const code = await runLog({
      cwd,
      argv: ["--problems"],
      write: (line) => lines.push(line),
    });
    assert.equal(code, 0);
    const text = lines.join("");
    assert.match(text, /unavailable/);
    assert.match(text, /The Planner exited without answering/);
    assert.doesNotMatch(text, /deliveries|listen {2}/);
  });

  it("--problems keeps a refused offer, with who refused it and why", async () => {
    const { cwd, ledgerRoot } = sandbox();
    const journal = openJournalFile(ledgerRoot, () => new Date("2026-09-26T17:13:42.000Z"));
    journal.append({ event: "listen", outcome: "completed", deliveries: 0 });
    journal.append({
      event: "submit-refused",
      key: "github:acme/app#3",
      by: "publisher",
      reason: "Could not publish issue/3: error: RPC failed; HTTP 400",
    });
    journal.append({ event: "ran", key: "github:acme/app#3", outcome: "escalated" });
    const lines: string[] = [];
    await runLog({ cwd, argv: ["--problems"], write: (line) => lines.push(line) });
    const text = lines.join("");
    assert.match(text, /submit-refused {2}github:acme\/app#3/);
    assert.match(text, /Could not publish issue\/3: error: RPC failed; HTTP 400/);
  });

  it("--all keeps idle", async () => {
    const { cwd, ledgerRoot } = sandbox();
    film(ledgerRoot);
    const lines: string[] = [];
    const code = await runLog({ cwd, argv: ["--all"], write: (line) => lines.push(line) });
    assert.equal(code, 0);
    assert.match(lines.join(""), /\bidle\b/);
  });

  it("--json prints the kept lines", async () => {
    const { cwd, ledgerRoot } = sandbox();
    film(ledgerRoot);
    const lines: string[] = [];
    const code = await runLog({ cwd, argv: ["--json"], write: (line) => lines.push(line) });
    assert.equal(code, 0);
    const parsed = JSON.parse(lines.join("")) as { event: string; detail?: string }[];
    assert.equal(
      parsed.some((line) => line.detail === "The Planner exited without answering."),
      true,
    );
    assert.equal(
      parsed.some((line) => line.event === "idle"),
      false,
    );
  });

  it("--json does not apply the default tail", async () => {
    const { cwd, ledgerRoot } = sandbox();
    const journal = openJournalFile(ledgerRoot, () => new Date("2026-09-23T14:09:53.000Z"));
    for (let index = 0; index < 90; index++) {
      journal.append({ event: "listen", outcome: "completed", deliveries: 1 });
    }
    const lines: string[] = [];
    const code = await runLog({ cwd, argv: ["--json"], write: (line) => lines.push(line) });
    assert.equal(code, 0);
    const parsed = JSON.parse(lines.join("")) as unknown[];
    assert.equal(parsed.length, 90);
  });

  it("--json --tail names how many lines were dropped", async () => {
    const { cwd, ledgerRoot } = sandbox();
    const journal = openJournalFile(ledgerRoot, () => new Date("2026-09-23T14:09:53.000Z"));
    for (let index = 0; index < 3; index++) {
      journal.append({ event: "listen", outcome: "completed", deliveries: 1 });
    }
    const lines: string[] = [];
    const code = await runLog({
      cwd,
      argv: ["--json", "--tail", "1"],
      write: (line) => lines.push(line),
    });
    assert.equal(code, 0);
    const parsed = JSON.parse(lines.join("")) as { kept: number; shown: number; lines: unknown[] };
    assert.equal(parsed.kept, 3);
    assert.equal(parsed.shown, 1);
    assert.equal(parsed.lines.length, 1);
  });

  it("tallies a paused run with no exit code apart from exit 1", async () => {
    const { cwd, ledgerRoot } = sandbox();
    const journal = openJournalFile(ledgerRoot, () => new Date("2026-09-23T14:09:53.000Z"));
    const detail = "The Planner exited without answering.";
    journal.append({
      event: "planner-finished",
      kind: "exited",
      exitCode: 1,
      key: "github:acme/app#3",
    });
    journal.append({
      event: "result",
      outcome: "unavailable",
      detail,
      key: "github:acme/app#3",
    });
    journal.append({ event: "planner-finished", kind: "exited", key: "github:acme/app#3" });
    journal.append({
      event: "result",
      outcome: "unavailable",
      detail,
      key: "github:acme/app#3",
    });
    journal.append({ event: "paused" });
    const lines: string[] = [];
    const code = await runLog({
      cwd,
      argv: ["--problems"],
      write: (line) => lines.push(line),
    });
    assert.equal(code, 0);
    const text = lines.join("");
    assert.match(text, /unavailable {2}The Planner exited without answering\. {2}exit 1\n/);
    assert.match(text, /interrupted {2}unavailable {2}The Planner exited without answering\./);
    assert.doesNotMatch(text, /×2/);
  });

  it("--tail limits the film and the tally still counts what was hidden", async () => {
    const { cwd, ledgerRoot } = sandbox();
    film(ledgerRoot);
    const lines: string[] = [];
    const code = await runLog({ cwd, argv: ["--tail", "1"], write: (line) => lines.push(line) });
    assert.equal(code, 0);
    const text = lines.join("");
    assert.match(text, /showing last 1 of/);
    assert.match(text, /unavailable {2}The Planner exited without answering/);
  });

  it("refuses a --tail that is not a number", async () => {
    const { cwd } = sandbox();
    const lines: string[] = [];
    const code = await runLog({ cwd, argv: ["--tail"], write: (line) => lines.push(line) });
    assert.equal(code, 2);
    assert.match(lines.join(""), /--tail needs a number/);
  });

  it("names the newest transcript with the agent exit from its header", async () => {
    const { cwd, ledgerRoot } = sandbox();
    film(ledgerRoot);
    const transcripts = join(cwd, "transcripts", "fake-1");
    mkdirSync(transcripts, { recursive: true });
    writeFileSync(
      join(transcripts, "breakdown-attempt-1.md"),
      "# breakdown · attempt 1\n\n- exit: 0\n- duration: 12.0s\n",
    );
    const config = JSON.parse(readFileSync(join(cwd, CONFIG_FILENAME), "utf8")) as {
      planner: { cmd: string[] };
    };
    config.planner.cmd.push("--transcript-dir", transcripts);
    writeFileSync(join(cwd, CONFIG_FILENAME), JSON.stringify(config));
    const lines: string[] = [];
    const code = await runLog({ cwd, argv: ["--problems"], write: (line) => lines.push(line) });
    assert.equal(code, 0);
    const text = lines.join("");
    assert.match(text, /transcripts/);
    assert.match(text, /exit 0/);
    assert.match(text, /duration 12\.0s/);
    assert.match(text, /breakdown-attempt-1\.md/);
  });

  it("exits 2 when the config cannot be opened", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "host-log-missing-"));
    const lines: string[] = [];
    const code = await runLog({ cwd, argv: [], write: (line) => lines.push(line) });
    assert.equal(code, 2);
    assert.match(lines.join(""), /Missing required/);
  });
});
