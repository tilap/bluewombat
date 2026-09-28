import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { stringify as stringifyYaml } from "yaml";
import { CONFIG_FILENAME } from "../config/find-config.js";
import { runDoctor } from "./doctor.js";

const node = process.execPath;
const here = dirname(fileURLToPath(import.meta.url));
const planner = join(here, "../../fixtures/planner-one-subtask.mjs");
const builder = join(here, "../../fixtures/builder-write-marker.mjs");
const gate = join(here, "../../fixtures/gate-pass.mjs");

function sandbox(config: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "host-doctor-"));
  mkdirSync(join(root, "stable"));
  mkdirSync(join(root, "source"));
  writeFileSync(
    join(root, CONFIG_FILENAME),
    stringifyYaml({
      workLine: { stable: "./stable", isolation: "@bluewombat/isolation-copy" },
      workspaceRoot: "./.mason/workspaces",
      ledger: "./.mason/ledger",
      planner: { cmd: [node, planner], timeoutMs: 600_000 },
      builder: {
        producer: { cmd: [node, builder], timeoutMs: 600_000 },
        repair: { cmd: [node, builder], timeoutMs: 600_000 },
        gates: { gates: [{ id: "check", argv: [node, gate], timeoutMs: 10_000 }] },
      },
      timeoutMs: 1000,
      ...config,
    }),
  );
  return root;
}

/** The blocks an Authority needs, so a reference is in play. */
function offering(): Record<string, unknown> {
  return {
    authority: { enabled: true, publish: [node, gate], refresh: [node, gate] },
    assembly: {
      fix: { cmd: [node, builder], timeoutMs: 600_000 },
      gates: { gates: [{ id: "check", argv: [node, gate], timeoutMs: 10_000 }] },
    },
  };
}

async function doctorIn(cwd: string, env: Record<string, string | undefined> = {}) {
  const lines: string[] = [];
  const code = await runDoctor({
    cwd,
    argv: [],
    env: { PATH: process.env.PATH, ...env },
    write: (line) => lines.push(line),
    nodeVersion: "24.20.0",
  });
  return { code, output: lines.join("") };
}

describe("runDoctor", () => {
  it("says which mode the fold is in, both ways", async () => {
    const off = await doctorIn(
      sandbox({
        manager: "@bluewombat/manager-fake",
        managerOptions: { source: "./source", target: "./threads" },
        authority: { enabled: false },
      }),
    );
    assert.match(off.output, /ok {4}authority — none/);

    const undeclared = await doctorIn(
      sandbox({
        manager: "@bluewombat/manager-fake",
        managerOptions: { source: "./source", target: "./threads" },
      }),
    );
    assert.match(undeclared.output, /warn {2}authority — not declared/);
  });

  it("fails an Authority on a git work line with no origin to read back from", async () => {
    // The fetch that follows an accepted Submission would fail on every tick,
    // and a skipped tick looks exactly like an idle one: nothing would ever run
    // and nothing would say why.
    const cwd = sandbox({
      manager: "@bluewombat/manager-fake",
      managerOptions: { source: "./source", target: "./threads" },
      workLine: { stable: "./stable", branch: "main", isolation: "@bluewombat/isolation-copy" },
      authority: { enabled: true, publish: [node, planner], refresh: [node, planner] },
      assembly: {
        fix: { cmd: [node, builder], timeoutMs: 600_000 },
      },
    });
    const stable = join(cwd, "stable");
    execFileSync("git", ["init", "-q", "-b", "main", stable]);
    execFileSync("git", ["-C", stable, "config", "user.email", "d@d.local"]);
    execFileSync("git", ["-C", stable, "config", "user.name", "D"]);
    writeFileSync(join(stable, "a.txt"), "one\n");
    execFileSync("git", ["-C", stable, "add", "-A"]);
    execFileSync("git", ["-C", stable, "commit", "-qm", "seed"]);

    const { code, output } = await doctorIn(cwd);

    assert.equal(code, 1);
    assert.match(output, /FAIL {2}work line remote/);
    assert.match(output, /no "origin"/);
  });

  it("fails on a Node.js older than the one mason needs", async () => {
    const cwd = sandbox({
      manager: "@bluewombat/manager-fake",
      managerOptions: { source: "./source", target: "./threads" },
    });
    const lines: string[] = [];
    const code = await runDoctor({
      cwd,
      argv: [],
      env: { PATH: process.env.PATH },
      write: (line) => lines.push(line),
      nodeVersion: "20.19.0",
    });
    assert.equal(code, 1);
    assert.match(lines.join(""), /FAIL {2}Node\.js/);
  });

  it("passes on a complete fake setup with copy isolation", async () => {
    const cwd = sandbox({
      manager: "@bluewombat/manager-fake",
      managerOptions: { source: "./source", target: "./threads" },
    });
    const { code, output } = await doctorIn(cwd);
    assert.equal(code, 0);
    assert.match(output, /Ready to run/);
    assert.match(output, /ok\s+workLine\.isolation — @bluewombat\/isolation-copy/);
  });

  it("warns when isolation is git but WorkLineStable has no .git", async () => {
    const cwd = sandbox({
      manager: "@bluewombat/manager-fake",
      managerOptions: { source: "./source", target: "./threads" },
      workLine: { stable: "./stable", isolation: "@bluewombat/isolation-git" },
    });
    const { code, output } = await doctorIn(cwd);
    assert.equal(code, 0);
    assert.match(output, /warn\s+workLine\.isolation/);
    assert.match(output, /no \.git/);
  });

  it("reads the reference the manager names and says the copy comes on the first run", async () => {
    const cwd = sandbox({
      manager: "@bluewombat/manager-github",
      managerOptions: { repo: "tilap/mason-test" },
      workLine: { isolation: "@bluewombat/isolation-git" },
      ...offering(),
    });
    const { output } = await doctorIn(cwd, { GITHUB_TOKEN: "t" });
    assert.match(output, /ok\s+reference — https:\/\/github\.com\/tilap\/mason-test\.git \(main\)/);
    assert.match(
      output,
      /ok\s+work line — .*\.mason\/work-line — copied from the reference on the first run/,
    );
    assert.doesNotMatch(output, /no \.git/);
  });

  it("fails a directory that is not a copy of the reference", async () => {
    const cwd = sandbox({
      manager: "@bluewombat/manager-github",
      managerOptions: { repo: "tilap/mason-test" },
      workLine: { stable: "./stable", isolation: "@bluewombat/isolation-git" },
      ...offering(),
    });
    const { code, output } = await doctorIn(cwd, { GITHUB_TOKEN: "t" });
    assert.equal(code, 1);
    assert.match(output, /FAIL {2}work line — .*is not a copy of the reference: .*not a git tree/);
  });

  it("fails a workLine.branch that disagrees with the reference", async () => {
    const cwd = sandbox({
      manager: "@bluewombat/manager-github",
      managerOptions: { repo: "tilap/mason-test" },
      workLine: { branch: "develop", isolation: "@bluewombat/isolation-git" },
      ...offering(),
    });
    const { code, output } = await doctorIn(cwd, { GITHUB_TOKEN: "t" });
    assert.equal(code, 1);
    assert.match(output, /FAIL {2}work line — "workLine.branch" is "develop", but .* names "main"/);
  });

  it("fails when neither workLine.stable nor the manager says where the work line is", async () => {
    const cwd = sandbox({
      manager: "@bluewombat/manager-fake",
      managerOptions: { source: "./source", target: "./threads" },
      workLine: { isolation: "@bluewombat/isolation-copy" },
    });
    const { code, output } = await doctorIn(cwd);
    assert.equal(code, 1);
    assert.match(output, /FAIL {2}work line — "workLine.stable" is not set/);
  });

  it("leaves the operator's directory alone when no Authority is declared", async () => {
    const cwd = sandbox({
      manager: "@bluewombat/manager-github",
      managerOptions: { repo: "tilap/mason-test" },
      authority: { enabled: false },
    });
    const { output } = await doctorIn(cwd, { GITHUB_TOKEN: "t" });
    assert.match(output, /ok\s+WorkLineStable — .*stable \(plain directory\)/);
    assert.doesNotMatch(output, /reference/);
  });

  it("reports the manager's own failing check", async () => {
    const cwd = sandbox({
      manager: "@bluewombat/manager-github",
      managerOptions: { repo: "tilap/mason" },
    });
    const { code, output } = await doctorIn(cwd);
    assert.equal(code, 1);
    assert.match(output, /FAIL {2}token/);
  });

  it("stops at the invocation when a required field is missing", async () => {
    const cwd = sandbox({ managerOptions: {} });
    const { code, output } = await doctorIn(cwd);
    assert.equal(code, 1);
    assert.match(output, /FAIL {2}invocation .*Missing required "manager"/);
  });

  it("fails a Gate whose command is nowhere", async () => {
    const cwd = sandbox({
      manager: "@bluewombat/manager-fake",
      managerOptions: { source: "./source", target: "./threads" },
      builder: {
        producer: { cmd: [node, builder], timeoutMs: 600_000 },
        repair: { cmd: [node, builder], timeoutMs: 600_000 },
        gates: { gates: [{ id: "check", argv: ["definitely-not-a-command"], timeoutMs: 1000 }] },
      },
    });
    const { code, output } = await doctorIn(cwd);
    assert.equal(code, 1);
    assert.match(output, /FAIL {2}Builder gate check/);
  });

  it("fails an Authority that cannot fix a Submission sent back", async () => {
    const { code, output } = await doctorIn(
      sandbox({
        manager: "@bluewombat/manager-fake",
        managerOptions: { source: "./source", target: "./threads" },
        workLine: { stable: "./stable", branch: "main", isolation: "@bluewombat/isolation-copy" },
        authority: { enabled: true, publish: [node, planner], refresh: [node, planner] },
      }),
    );
    assert.equal(code, 1);
    assert.match(output, /FAIL {2}assembly fix/);
    assert.match(output, /assembly\.fix/);
  });

  it("checks assembly.validate's command when declared, and says nothing new when absent", async () => {
    const withValidate = await doctorIn(
      sandbox({
        manager: "@bluewombat/manager-fake",
        managerOptions: { source: "./source", target: "./threads" },
        assembly: {
          validate: { cmd: [node, builder], timeoutMs: 600_000 },
          gates: { gates: [{ id: "check", argv: [node, gate], timeoutMs: 10_000 }] },
        },
      }),
    );
    assert.match(withValidate.output, /ok {4}Assembly validate/);

    const withoutValidate = await doctorIn(
      sandbox({
        manager: "@bluewombat/manager-fake",
        managerOptions: { source: "./source", target: "./threads" },
      }),
    );
    assert.doesNotMatch(withoutValidate.output, /Assembly validate/);
  });

  it("no longer warns that fix is dead without an Authority, once validate can send work back to it", async () => {
    const { output } = await doctorIn(
      sandbox({
        manager: "@bluewombat/manager-fake",
        managerOptions: { source: "./source", target: "./threads" },
        assembly: {
          fix: { cmd: [node, builder], timeoutMs: 600_000 },
          validate: { cmd: [node, builder], timeoutMs: 600_000 },
          gates: { gates: [{ id: "check", argv: [node, gate], timeoutMs: 10_000 }] },
        },
      }),
    );
    assert.doesNotMatch(output, /assembly fix.*it will never run/);
  });

  it("still warns that fix is dead without an Authority or a validate to feed it", async () => {
    const { output } = await doctorIn(
      sandbox({
        manager: "@bluewombat/manager-fake",
        managerOptions: { source: "./source", target: "./threads" },
        assembly: {
          fix: { cmd: [node, builder], timeoutMs: 600_000 },
          gates: { gates: [{ id: "check", argv: [node, gate], timeoutMs: 10_000 }] },
        },
      }),
    );
    assert.match(output, /warn {2}assembly fix.*it will never run/);
  });

  it("says a validate with no fix escalates rather than failing the check", async () => {
    const { code, output } = await doctorIn(
      sandbox({
        manager: "@bluewombat/manager-fake",
        managerOptions: { source: "./source", target: "./threads" },
        assembly: {
          validate: { cmd: [node, builder], timeoutMs: 600_000 },
          gates: { gates: [{ id: "check", argv: [node, gate], timeoutMs: 10_000 }] },
        },
      }),
    );
    assert.equal(code, 0);
    assert.match(output, /warn {2}assembly fix.*escalate/);
  });
});
