import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { stringify as stringifyYaml } from "yaml";
import { DEFAULT_CONFIG_FILENAME } from "../config/find-config.js";
import type { Host } from "../loop/tick.js";
import { runRun } from "./run.js";

const node = process.execPath;
const here = dirname(fileURLToPath(import.meta.url));
const builder = join(here, "../../fixtures/builder-write-marker.mjs");
const gate = join(here, "../../fixtures/gate-pass.mjs");

function sandbox(config: Record<string, unknown> = {}, without: string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), "host-run-"));
  mkdirSync(join(root, "stable"));
  mkdirSync(join(root, "source"));
  const fake = {
    package: "@bluewombat/manager-fake",
    options: { source: "./source", target: "./threads" },
  };
  const document: Record<string, unknown> = {
    featureTracker: fake,
    ticketTracker: fake,
    workLine: { stable: "./stable", isolation: "@bluewombat/isolation-copy" },
    workspaceRoot: "./.mason/workspaces",
    ledger: "./.mason/ledger",
    builder: {
      producer: {
        cmd: [node, builder],
        timeoutMs: 600_000,
        gates: { gates: [{ id: "check", argv: [node, gate], timeoutMs: 10_000 }] },
      },
      repair: { cmd: [node, builder], timeoutMs: 600_000 },
    },
    timeoutMs: 1000,
    pollIntervalMs: 30_000,
    ...config,
  };
  for (const key of without) {
    delete document[key];
  }
  writeFileSync(join(root, DEFAULT_CONFIG_FILENAME), stringifyYaml(document));
  return root;
}

type HostLike = Pick<Host, "run" | "close">;

async function runIn(
  cwd: string,
  open?: () => Promise<HostLike>,
  interruptFlag = { interrupted: false },
  argv: string[] = [],
) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runRun({
    cwd,
    argv,
    write: (text) => out.push(text),
    writeError: (text) => err.push(text),
    interruptFlag,
    ...(open === undefined ? {} : { open }),
  });
  return { code, out: out.join(""), err: err.join("") };
}

const finished = (lastRun?: { outcome: string }): HostLike =>
  ({
    run: async () => ({
      listenerOutcome: "completed",
      reported: [],
      ...(lastRun ? { lastRun } : {}),
    }),
    close: async () => {},
  }) as unknown as HostLike;

describe("runRun", () => {
  it("speaks first, whatever follows: even arguments it refuses", async () => {
    const { code, out, err } = await runIn(mkdtempSync(join(tmpdir(), "host-run-empty-")));
    assert.equal(code, 2);
    assert.match(out.split("\n")[0] ?? "", /^\d\d:\d\d:\d\d run {8}starting$/);
    assert.match(out, /stopped {4}not started, exit 2/);
    assert.notEqual(err, "");
  });

  it("says what it is running with, then that it started, then that it stopped", async () => {
    const { code, out } = await runIn(sandbox(), async () => finished());
    assert.equal(code, 0);
    const labels = out
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => line.slice(9, 20).trim());
    assert.deepEqual(labels, [
      "run",
      "config",
      "trackers",
      "ledger",
      "poll",
      "opening",
      "started",
      "stopped",
    ]);
    assert.match(
      out,
      /trackers {3}features @bluewombat\/manager-fake, tickets @bluewombat\/manager-fake/,
    );
    assert.match(out, /poll {7}every 30s/);
    assert.match(out, /started {4}pid \d+, Ctrl-C to stop/);
    assert.match(out, /stopped {4}finished/);
  });

  it("says it runs once when no interval is configured", async () => {
    const { out } = await runIn(sandbox({}, ["pollIntervalMs"]), async () => finished());
    assert.match(out, /poll {7}once, then stop/);
  });

  it("says why it stopped, and exits as before: interrupted, refused, failed", async () => {
    const flag = { interrupted: true };
    const interrupted = await runIn(sandbox(), async () => finished(), flag);
    assert.equal(interrupted.code, 130);
    assert.match(interrupted.out, /stopped {4}interrupted, exit 130/);

    const refused = await runIn(sandbox(), async () => finished({ outcome: "refused" }));
    assert.equal(refused.code, 1);
    assert.match(refused.out, /stopped {4}the last run was refused, exit 1/);

    const failed = await runIn(sandbox(), async () => {
      throw new Error("the lock is held");
    });
    assert.equal(failed.code, 2);
    assert.match(failed.err, /the lock is held/);
    assert.match(failed.out, /stopped {4}failed, exit 2/);
    assert.match(failed.out, /opening/);
  });

  it("closes the host it opened, and none it did not", async () => {
    let closed = 0;
    await runIn(sandbox(), async () => ({
      run: async () => ({ listenerOutcome: "completed", reported: [] }),
      close: async () => {
        closed += 1;
      },
    }));
    assert.equal(closed, 1);
  });
});
