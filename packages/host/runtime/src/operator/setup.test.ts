import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG_FILENAME } from "../config/find-config.js";
import { fixtureYaml as stringifyYaml } from "../config/fixture-yaml.js";
import { runSetup } from "./setup.js";

const node = process.execPath;
const here = dirname(fileURLToPath(import.meta.url));
const builder = join(here, "../../fixtures/builder-write-marker.mjs");
const gate = join(here, "../../fixtures/gate-pass.mjs");

function sandbox(config: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "host-setup-"));
  mkdirSync(join(root, "stable"));
  mkdirSync(join(root, "source"));
  writeFileSync(
    join(root, DEFAULT_CONFIG_FILENAME),
    stringifyYaml({
      workLine: { stable: "./stable", isolation: "@bluewombat/isolation-copy" },
      workspaceRoot: "./.mason/workspaces",
      ledger: "./.mason/ledger",
      builder: {
        producer: {
          cmd: [node, builder],
          timeoutMs: 600_000,
        },
        repair: { cmd: [node, builder], timeoutMs: 600_000 },
        gates: { gates: [{ id: "check", argv: [node, gate], timeoutMs: 10_000 }] },
      },
      timeoutMs: 1000,
      ...config,
    }),
  );
  return root;
}

async function setupIn(cwd: string, argv: string[] = [], env: Record<string, string> = {}) {
  const lines: string[] = [];
  const code = await runSetup({ cwd, argv, env, write: (line) => lines.push(line) });
  return { code, output: lines.join("") };
}

describe("runSetup", () => {
  it("says so when the manager has nothing to set up", async () => {
    const cwd = sandbox({
      featureTracker: {
        package: "@bluewombat/manager-fake",
        options: { source: "./source", target: "./threads" },
      },
      ticketTracker: {
        package: "@bluewombat/manager-fake",
        options: { source: "./source", target: "./threads" },
      },
    });
    const { code, output } = await setupIn(cwd);
    assert.equal(code, 0);
    assert.match(output, /nothing to set up/);
  });

  it("reports the manager's blocked step and exits 1", async () => {
    const cwd = sandbox({
      featureTracker: { package: "@bluewombat/manager-github", options: { repo: "tilap/mason" } },
      ticketTracker: { package: "@bluewombat/manager-github", options: { repo: "tilap/mason" } },
    });
    const { code, output } = await setupIn(cwd);
    assert.equal(code, 1);
    assert.match(output, /FAIL {2}a token to talk to GitHub/);
    assert.match(output, /1 step\(s\) blocked/);
  });

  it("stops at the invocation when a required field is missing", async () => {
    const cwd = sandbox({ timeoutMs: 1000 });
    const { code, output } = await setupIn(cwd);
    assert.equal(code, 2);
    assert.match(output, /Missing required "feature.tracker.package"/);
  });

  it("prints a plan, then points at --apply", async () => {
    const cwd = sandbox({
      featureTracker: { package: join(here, "../../fixtures/manager-setup-stub.mjs"), options: {} },
      ticketTracker: { package: join(here, "../../fixtures/manager-setup-stub.mjs"), options: {} },
    });
    const plan = await setupIn(cwd);
    assert.equal(plan.code, 0);
    assert.match(plan.output, /todo {2}create label ready/);
    assert.match(plan.output, /mason setup --apply/);

    const applied = await setupIn(cwd, ["--apply"]);
    assert.equal(applied.code, 0);
    assert.match(applied.output, /done {2}create label ready/);
    assert.match(applied.output, /1 step\(s\) applied/);
  });
});
