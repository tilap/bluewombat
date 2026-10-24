import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { DEFAULT_CONFIG_FILENAME } from "../config/find-config.js";
import { openJournalFile } from "../loop/journal.js";
import { runLog } from "./log.js";

const node = process.execPath;
const here = dirname(fileURLToPath(import.meta.url));
const builder = join(here, "../../fixtures/builder-write-marker.mjs");
const gate = join(here, "../../fixtures/gate-pass.mjs");

function sandbox(): { cwd: string; ledgerRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "host-log-"));
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
        tests: { agent: false },
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

function film(ledgerRoot: string): void {
  const journal = openJournalFile(ledgerRoot, () => new Date("2026-09-23T14:09:53.000Z"));
  journal.append({ event: "idle" });
  journal.append({ event: "listen", outcome: "completed", deliveries: 0 });
  journal.append({ event: "listen", outcome: "completed", deliveries: 1 });
  journal.append({
    event: "result",
    outcome: "unavailable",
    detail: "The tracker did not answer.",
    key: "github:acme/app#3",
  });
  journal.append({ event: "ran", key: "github:acme/app#3", outcome: "refused", state: "running" });
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
    assert.match(text, /The tracker did not answer/);
    assert.doesNotMatch(text, /\bidle\b/);
    assert.match(text, /quiet lines hidden/);
    assert.match(text, /unavailable {2}The tracker did not answer\./);
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
    assert.match(text, /The tracker did not answer/);
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
      parsed.some((line) => line.detail === "The tracker did not answer."),
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

  it("tallies the same stop once, with how many times it happened", async () => {
    const { cwd, ledgerRoot } = sandbox();
    const journal = openJournalFile(ledgerRoot, () => new Date("2026-09-23T14:09:53.000Z"));
    const detail = "The tracker did not answer.";
    for (let index = 0; index < 2; index++) {
      journal.append({ event: "result", outcome: "unavailable", detail, key: "github:acme/app#3" });
    }
    const lines: string[] = [];
    const code = await runLog({
      cwd,
      argv: ["--problems"],
      write: (line) => lines.push(line),
    });
    assert.equal(code, 0);
    assert.match(lines.join(""), /unavailable {2}The tracker did not answer\. {2}×2/);
  });

  it("--tail limits the film and the tally still counts what was hidden", async () => {
    const { cwd, ledgerRoot } = sandbox();
    film(ledgerRoot);
    const lines: string[] = [];
    const code = await runLog({ cwd, argv: ["--tail", "1"], write: (line) => lines.push(line) });
    assert.equal(code, 0);
    const text = lines.join("");
    assert.match(text, /showing last 1 of/);
    assert.match(text, /unavailable {2}The tracker did not answer/);
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
      join(transcripts, "builder-attempt-1.md"),
      "# builder · attempt 1\n\n- exit: 0\n- duration: 12.0s\n",
    );
    const config = parseYaml(readFileSync(join(cwd, DEFAULT_CONFIG_FILENAME), "utf8")) as {
      builder: { tests: { agent: false }; producer: { cmd: string[] } };
    };
    config.builder.producer.cmd.push("--transcript-dir", transcripts);
    writeFileSync(join(cwd, DEFAULT_CONFIG_FILENAME), stringifyYaml(config));
    const lines: string[] = [];
    const code = await runLog({ cwd, argv: ["--problems"], write: (line) => lines.push(line) });
    assert.equal(code, 0);
    const text = lines.join("");
    assert.match(text, /transcripts/);
    assert.match(text, /exit 0/);
    assert.match(text, /duration 12\.0s/);
    assert.match(text, /builder-attempt-1\.md/);
  });

  it("exits 2 when the config cannot be opened", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "host-log-missing-"));
    const lines: string[] = [];
    const code = await runLog({ cwd, argv: [], write: (line) => lines.push(line) });
    assert.equal(code, 2);
    assert.match(lines.join(""), /Missing required/);
  });
});
