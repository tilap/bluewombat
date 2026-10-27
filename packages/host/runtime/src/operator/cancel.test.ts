import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { stringify as stringifyYaml } from "yaml";
import { DEFAULT_CONFIG_FILENAME } from "../config/find-config.js";
import { openHost } from "../loop/open-host.js";
import { runCancel } from "./cancel.js";

const node = process.execPath;
const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "../../fixtures");
const builder = join(fixtures, "builder-write-marker.mjs");
const gateFail = join(fixtures, "gate-fail-blocking.mjs");

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), "host-cancel-"));
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
        producer: {
          cmd: [node, builder],
          timeoutMs: 30_000,
        },
        repair: { cmd: [node, builder], timeoutMs: 30_000 },
        gates: { gates: [{ id: "check", argv: [node, gateFail], timeoutMs: 10_000 }] },
      },
      timeoutMs: 30_000,
    }),
  );
  return root;
}

async function cancelIn(cwd: string, argv: string[]) {
  const lines: string[] = [];
  const code = await runCancel({
    cwd,
    argv,
    write: (line) => lines.push(line),
  });
  return { code, output: lines.join("") };
}

describe("runCancel", () => {
  it("refuses a missing key", async () => {
    const { code, output } = await cancelIn(sandbox(), []);
    assert.equal(code, 2);
    assert.match(output, /cancel <key>/);
  });

  it("refuses a key the ledger does not know", async () => {
    const { code, output } = await cancelIn(sandbox(), ["fake:99"]);
    assert.equal(code, 2);
    assert.match(output, /No Ticket named "fake:99"/);
  });

  it("abandons an escalated Ticket by key", async () => {
    const cwd = sandbox();
    writeFileSync(
      join(cwd, "source", "0001-create.json"),
      JSON.stringify({
        id: "42",
        project: "proj",
        intention: "deliver the marker file",
        priority: 75,
      }),
    );
    const host = await openHost({
      featureTracker: {
        package: "@bluewombat/manager-fake",
        options: {
          source: join(cwd, "source"),
          target: join(cwd, "threads"),
        },
      },
      ticketTracker: {
        package: "@bluewombat/manager-fake",
        options: {
          source: join(cwd, "source"),
          target: join(cwd, "threads"),
        },
      },
      workLineStable: join(cwd, "stable"),
      workLineIsolation: "@bluewombat/isolation-copy",
      workspaceRoot: join(cwd, ".mason/workspaces"),
      ledgerRoot: join(cwd, ".mason/ledger"),
      builder: {
        producer: {
          cmd: [node, builder],
          timeoutMs: 30_000,
          gates: [{ id: "check", argv: [node, gateFail], timeoutMs: 10_000 }],
        },
        repair: { cmd: [node, builder], timeoutMs: 30_000, gates: [] },
      },
      ticket: { gates: [] },
      timeoutMs: 30_000,
    });
    await host.runOnce();
    await host.close();

    const { code, output } = await cancelIn(cwd, ["fake:42"]);
    assert.equal(code, 0);
    assert.match(output, /Cancelled fake:42/);
  });
});
