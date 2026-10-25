import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { openFilesystemPersist } from "@bluewombat/persist-fs";
import { openWorkLedger } from "@bluewombat/work-ledger";
import { stringify as stringifyYaml } from "yaml";
import { DEFAULT_CONFIG_FILENAME } from "../config/find-config.js";
import { openJournalFile } from "../loop/journal.js";
import { runIncident } from "./incident.js";

const node = process.execPath;
const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "../../fixtures");
const builder = join(fixtures, "builder-write-marker.mjs");
const gateFail = join(fixtures, "gate-fail-blocking.mjs");

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), "host-incident-"));
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
        tests: { agent: false, gates: [] },
        producer: { cmd: [node, builder], timeoutMs: 30_000 },
        repair: { cmd: [node, builder], timeoutMs: 30_000 },
        gates: { gates: [{ id: "check", argv: [node, gateFail], timeoutMs: 10_000 }] },
      },
      timeoutMs: 30_000,
    }),
  );
  return root;
}

/** A Feature with one done Ticket and one that stopped on a Gate, and the journal that saw it. */
async function escalate(cwd: string): Promise<void> {
  const ledgerRoot = join(cwd, ".mason/ledger");
  const ledger = openWorkLedger({ persist: await openFilesystemPersist({ root: ledgerRoot }) });
  const intention = (key: string, extra: object = {}) => ({
    key,
    project: "proj",
    fingerprint: "f",
    priority: 50,
    intention: `deliver ${key}`,
    ...extra,
  });
  await ledger.admitFeature({
    ...intention("fake:o/r#1"),
    blocked_by: [],
    merge_when_ready: false,
  });
  await ledger.admit(intention("fake:o/r#42", { feature: "fake:o/r#1" }));
  await ledger.openFeature({ key: "fake:o/r#1", tickets: ["fake:o/r#42"] });
  await ledger.claim("proj");
  await ledger.startUnit("fake:o/r#42");
  await ledger.recordAttempt({
    key: "fake:o/r#42",
    number: 1,
    trace: { ended: "fail-blocking", report: "assembly gate blocked", refusedBy: "check" },
  });
  await ledger.escalate({
    key: "fake:o/r#42",
    kind: "unit",
    report: "assembly gate blocked",
    refusedBy: "check",
  });
  const journal = openJournalFile(ledgerRoot);
  journal.append({
    event: "gate-finished",
    key: "fake:o/r#42",
    task_id: "fake:o/r#42",
    attempt: 1,
    gate_id: "check",
    verdict: "fail-blocking",
    report: "assembly gate blocked",
  });
  journal.append({
    event: "status",
    key: "fake:o/r#42",
    task_id: "fake:o/r#42",
    phase: "escalated",
    attempt: 1,
  });
}

async function incidentIn(cwd: string, argv: string[]) {
  const lines: string[] = [];
  const code = await runIncident({ cwd, argv, write: (text) => lines.push(text) });
  return { code, output: lines.join("") };
}

describe("runIncident", () => {
  it("says nothing waits when nothing does", async () => {
    const { code, output } = await incidentIn(sandbox(), []);
    assert.equal(code, 0);
    assert.match(output, /Nothing is waiting for a person/);
  });

  it("refuses a key the ledger does not know", async () => {
    const { code, output } = await incidentIn(sandbox(), ["fake:99"]);
    assert.equal(code, 2);
    assert.match(output, /No Ticket or Feature matches fake:99/);
  });

  it("lists, then gathers, a Ticket that stopped on a Gate", async () => {
    const cwd = sandbox();
    await escalate(cwd);

    const listed = await incidentIn(cwd, []);
    assert.equal(listed.code, 0);
    assert.match(listed.output, /fake:o\/r#42\s+ticket/);

    const page = await incidentIn(cwd, ["fake:o/r#42"]);
    assert.equal(page.code, 0);
    assert.match(page.output, /^# Incident: fake:o\/r#42/);
    assert.match(page.output, /layer: unit/);
    assert.match(page.output, /assembly gate blocked/);
    assert.match(page.output, /gate-finished check fail-blocking/);

    const asJson = await incidentIn(cwd, ["fake:o/r#42", "--json"]);
    const dossier = JSON.parse(asJson.output);
    assert.equal(dossier.schema, "bluewombat.incident/1");
    assert.equal(dossier.stop.gate.id, "check");
    assert.equal(dossier.stop.refused_by, "check");
    assert.equal(dossier.parent.key, "fake:o/r#1");
  });

  it("finds a Ticket by its tracker number and writes both files with --out", async () => {
    const cwd = sandbox();
    await escalate(cwd);
    const out = join(cwd, "dossier");
    const { code, output } = await incidentIn(cwd, ["#42", "--out", out]);
    assert.equal(code, 0);
    assert.match(output, /incident fake:o\/r#42/);
    assert.ok(existsSync(join(out, "incident.md")));
    assert.equal(
      JSON.parse(readFileSync(join(out, "incident.json"), "utf8")).subject.key,
      "fake:o/r#42",
    );
  });
});
