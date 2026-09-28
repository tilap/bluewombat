import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { stringify as stringifyYaml } from "yaml";
import { CONFIG_FILENAME } from "./find-config.js";
import { parseArgs } from "./parse-args.js";

const node = process.execPath;
const here = dirname(fileURLToPath(import.meta.url));
const planner = join(here, "../../fixtures/planner-one-subtask.mjs");
const builder = join(here, "../../fixtures/builder-write-marker.mjs");
const gate = join(here, "../../fixtures/gate-pass.mjs");

function dirs() {
  const root = mkdtempSync(join(tmpdir(), "host-args-"));
  const workLineStable = join(root, "stable");
  const source = join(root, "source");
  const target = join(root, "threads");
  mkdirSync(workLineStable);
  mkdirSync(source);
  mkdirSync(target);
  writeFileSync(join(workLineStable, "seed.txt"), "ok\n");
  return {
    root,
    workLineStable,
    source,
    target,
    workspaceRoot: join(root, "workspaces"),
    ledgerRoot: join(root, "ledger"),
  };
}

function slots() {
  return [
    "--planner",
    "--",
    node,
    planner,
    "--planner-timeout-ms",
    "600000",
    "--builder",
    "--",
    node,
    builder,
    "--builder-timeout-ms",
    "600000",
    "--builder-repair",
    "--",
    node,
    builder,
    "--builder-repair-timeout-ms",
    "600000",
    "--builder-gate-timeout-ms",
    "60000",
    "--builder-gate",
    "check",
    "--",
    node,
    gate,
    "--timeout-ms",
    "60000",
  ];
}

function paths(dir: ReturnType<typeof dirs>) {
  return [
    "--work-line-stable",
    dir.workLineStable,
    "--work-line-isolation",
    "@bluewombat/isolation-copy",
    "--workspace-root",
    dir.workspaceRoot,
    "--ledger",
    dir.ledgerRoot,
  ];
}

function configOf(dir: ReturnType<typeof dirs>, over: Record<string, unknown> = {}) {
  return {
    manager: "@bluewombat/manager-github",
    workLine: { stable: dir.workLineStable, isolation: "@bluewombat/isolation-copy" },
    workspaceRoot: dir.workspaceRoot,
    ledger: dir.ledgerRoot,
    managerOptions: { repo: "tilap/mason", defaultProject: "from-config" },
    planner: { cmd: [node, planner], timeoutMs: 600_000 },
    builder: {
      producer: { cmd: [node, builder], timeoutMs: 600_000 },
      repair: { cmd: [node, builder], timeoutMs: 600_000 },
      gates: { defaultTimeoutMs: 60_000, gates: [{ id: "check", argv: [node, gate] }] },
    },
    timeoutMs: 1000,
    ...over,
  };
}

describe("parseArgs", () => {
  it("takes the manager and its options from flags alone", () => {
    const dir = dirs();
    const parsed = parseArgs(
      [
        "--manager",
        "@bluewombat/manager-fake",
        "--manager-option",
        `source=${dir.source}`,
        "--manager-option",
        `target=${dir.target}`,
        ...paths(dir),
        ...slots(),
      ],
      { cwd: dir.root },
    );
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.invocation.manager, "@bluewombat/manager-fake");
      assert.deepEqual(parsed.invocation.managerOptions, {
        source: dir.source,
        target: dir.target,
      });
    }
  });

  it("collects a repeated --manager-option into an array", () => {
    const dir = dirs();
    const parsed = parseArgs(
      [
        "--manager",
        "@bluewombat/manager-github",
        "--manager-option",
        "labels=mason",
        "--manager-option",
        "labels=urgent",
        ...paths(dir),
        ...slots(),
      ],
      { cwd: dir.root },
    );
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.deepEqual(parsed.invocation.managerOptions.labels, ["mason", "urgent"]);
    }
  });

  it("refuses a --manager-option that is not key=value", () => {
    const dir = dirs();
    const parsed = parseArgs(["--manager-option", "labels", ...paths(dir), ...slots()], {
      cwd: dir.root,
    });
    assert.equal(parsed.ok, false);
    if (!parsed.ok) {
      assert.match(parsed.reason, /key=value/);
    }
  });

  it("fills from --config, and a flag option overrides only its own key", () => {
    const dir = dirs();
    const configPath = join(dir.root, "mason.yaml");
    writeFileSync(configPath, stringifyYaml(configOf(dir)));
    const parsed = parseArgs(
      [
        "--config",
        configPath,
        "--manager-option",
        "defaultProject=from-flag",
        "--timeout-ms",
        "9000",
      ],
      { cwd: dir.root },
    );
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.invocation.manager, "@bluewombat/manager-github");
      assert.equal(parsed.invocation.timeoutMs, 9000);
      assert.deepEqual(parsed.invocation.managerOptions, {
        repo: "tilap/mason",
        defaultProject: "from-flag",
      });
      assert.equal(parsed.invocation.configDir, dir.root);
    }
  });

  it("finds the nearest mason.config.yaml without --config", () => {
    const dir = dirs();
    writeFileSync(join(dir.root, CONFIG_FILENAME), stringifyYaml(configOf(dir)));
    const nested = join(dir.root, "nested");
    mkdirSync(nested);
    const parsed = parseArgs([], { cwd: nested });
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.invocation.manager, "@bluewombat/manager-github");
      assert.equal(parsed.invocation.configDir, dir.root);
    }
  });

  it("reads observability.streams and resolves its directory against the config", () => {
    const dir = dirs();
    const configPath = join(dir.root, "mason.yaml");
    const config = configOf(dir) as Record<string, unknown>;
    config.observability = { streams: { enabled: true, dir: "./films", keep: ["stderr"] } };
    writeFileSync(configPath, stringifyYaml(config));
    const parsed = parseArgs(["--config", configPath], { cwd: dir.root });
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      const streams = parsed.invocation.observability?.streams;
      assert.equal(streams?.enabled, true);
      // This system writes here, so the path is the config's, not a child's cwd.
      assert.equal(streams?.dir, join(dir.root, "films"));
      assert.deepEqual(streams?.keep, ["stderr"]);
    }
  });

  it("--streams-dir turns filming on and resolves against the cwd", () => {
    const dir = dirs();
    const parsed = parseArgs(
      [
        ...paths(dir),
        ...slots(),
        "--manager",
        "@bluewombat/manager-fake",
        "--streams-dir",
        "films",
      ],
      { cwd: dir.root },
    );
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.invocation.observability?.streams?.enabled, true);
      assert.equal(parsed.invocation.observability?.streams?.dir, join(dir.root, "films"));
    }
  });

  it("refuses an unknown key under observability.streams", () => {
    const dir = dirs();
    const configPath = join(dir.root, "mason.yaml");
    const config = configOf(dir) as Record<string, unknown>;
    config.observability = { streams: { enabled: true, rotate: true } };
    writeFileSync(configPath, stringifyYaml(config));
    const parsed = parseArgs(["--config", configPath], { cwd: dir.root });
    assert.equal(parsed.ok, false);
    if (!parsed.ok) {
      assert.match(parsed.reason, /"observability.streams" has unknown key "rotate"/);
    }
  });

  it("refuses streams without a declared enabled: filming is a decision", () => {
    const dir = dirs();
    const configPath = join(dir.root, "mason.yaml");
    const config = configOf(dir) as Record<string, unknown>;
    config.observability = { streams: { dir: "./films" } };
    writeFileSync(configPath, stringifyYaml(config));
    const parsed = parseArgs(["--config", configPath], { cwd: dir.root });
    assert.equal(parsed.ok, false);
    if (!parsed.ok) {
      assert.match(parsed.reason, /"observability.streams.enabled" must be true or false/);
    }
  });

  it("leaves observability unset when the config says nothing", () => {
    const dir = dirs();
    const configPath = join(dir.root, "mason.yaml");
    writeFileSync(configPath, stringifyYaml(configOf(dir)));
    const parsed = parseArgs(["--config", configPath], { cwd: dir.root });
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.invocation.observability, undefined);
    }
  });

  it("refuses a tracker field at the top level of the config", () => {
    const dir = dirs();
    const configPath = join(dir.root, "mason.yaml");
    const config = configOf(dir) as Record<string, unknown>;
    config.repo = "tilap/mason";
    writeFileSync(configPath, stringifyYaml(config));
    const parsed = parseArgs(["--config", configPath], { cwd: dir.root });
    assert.equal(parsed.ok, false);
    if (!parsed.ok) {
      assert.match(parsed.reason, /unknown key "repo"/);
    }
  });

  it("requires a manager", () => {
    const dir = dirs();
    const parsed = parseArgs([...paths(dir), ...slots()], { cwd: dir.root });
    assert.equal(parsed.ok, false);
    if (!parsed.ok) {
      assert.match(parsed.reason, /Missing required "manager"/);
    }
  });

  it("accepts an empty Gate sequence", () => {
    const dir = dirs();
    const configPath = join(dir.root, "mason.yaml");
    writeFileSync(
      configPath,
      stringifyYaml(
        configOf(dir, {
          builder: {
            producer: { cmd: [node, builder], timeoutMs: 600_000 },
            repair: { cmd: [node, builder], timeoutMs: 600_000 },
            gates: { defaultTimeoutMs: 60_000, gates: [] },
          },
        }),
      ),
    );
    const parsed = parseArgs(["--config", configPath], { cwd: dir.root });
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.deepEqual(parsed.invocation.builder.gates, []);
    }
  });

  it("resolves a relative path against the working directory", () => {
    const dir = dirs();
    const parsed = parseArgs(
      [
        "--manager",
        "@bluewombat/manager-fake",
        "--work-line-stable",
        "stable",
        "--work-line-isolation",
        "@bluewombat/isolation-copy",
        "--workspace-root",
        "workspaces",
        "--ledger",
        "ledger",
        ...slots(),
      ],
      { cwd: dir.root },
    );
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.invocation.workLineStable, dir.workLineStable);
      assert.equal(parsed.invocation.ledgerRoot, dir.ledgerRoot);
    }
  });

  it("resolves a directory the slot writes to, even before it exists", () => {
    const dir = dirs();
    writeFileSync(
      join(dir.root, CONFIG_FILENAME),
      stringifyYaml(
        configOf(dir, {
          builder: {
            producer: {
              cmd: [node, builder, "--transcript-dir", "./.mason/transcripts"],
              timeoutMs: 600_000,
            },
            repair: { cmd: [node, builder], timeoutMs: 600_000 },
          },
        }),
      ),
    );
    const parsed = parseArgs([], { cwd: dir.root });
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      // Left relative it would resolve against the Task workspace, which is
      // published and then destroyed.
      assert.equal(
        parsed.invocation.builder.producer.cmd.at(-1),
        join(dir.root, ".mason", "transcripts"),
      );
    }
  });

  it("carries workLine.branch from the config to the invocation", () => {
    const dir = dirs();
    writeFileSync(
      join(dir.root, CONFIG_FILENAME),
      stringifyYaml({
        ...configOf(dir),
        workLine: {
          stable: dir.workLineStable,
          branch: "dev",
          isolation: "@bluewombat/isolation-copy",
        },
      }),
    );
    const parsed = parseArgs(["--config", join(dir.root, CONFIG_FILENAME)], { cwd: dir.root });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) {
      return;
    }
    // A key that loads but never reaches the invocation is invisible: it is
    // what kept an Authority from ever being wired.
    assert.equal(parsed.invocation.workLineBranch, "dev");
  });

  it("carries workLine.isolationOptions to the invocation unread, and refuses a non-object", () => {
    const dir = dirs();
    const withOptions = {
      ...configOf(dir),
      workLine: {
        stable: dir.workLineStable,
        isolation: "@bluewombat/isolation-copy",
        isolationOptions: { exclude: [".env", "**/*.log"] },
      },
    };
    writeFileSync(join(dir.root, CONFIG_FILENAME), stringifyYaml(withOptions));
    const parsed = parseArgs(["--config", join(dir.root, CONFIG_FILENAME)], { cwd: dir.root });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) {
      return;
    }
    assert.deepEqual(parsed.invocation.workLineIsolationOptions, {
      exclude: [".env", "**/*.log"],
    });

    writeFileSync(
      join(dir.root, CONFIG_FILENAME),
      stringifyYaml({
        ...withOptions,
        workLine: { ...withOptions.workLine, isolationOptions: [] },
      }),
    );
    const refused = parseArgs(["--config", join(dir.root, CONFIG_FILENAME)], { cwd: dir.root });
    assert.equal(refused.ok, false);
    assert.match(refused.ok ? "" : refused.reason, /isolationOptions.*YAML mapping/);
  });

  it("takes the work line to fold onto from a flag too", () => {
    const dir = dirs();
    writeFileSync(join(dir.root, CONFIG_FILENAME), stringifyYaml(configOf(dir)));
    const parsed = parseArgs(
      ["--config", join(dir.root, CONFIG_FILENAME), "--work-line-branch", "trunk"],
      { cwd: dir.root },
    );
    assert.equal(parsed.ok, true);
    if (!parsed.ok) {
      return;
    }
    assert.equal(parsed.invocation.workLineBranch, "trunk");
  });

  it("names the persistence backend from the config, a flag, or the default", () => {
    const dir = dirs();
    writeFileSync(join(dir.root, CONFIG_FILENAME), stringifyYaml(configOf(dir)));
    const config = join(dir.root, CONFIG_FILENAME);

    const defaulted = parseArgs(["--config", config], { cwd: dir.root });
    assert.ok(defaulted.ok);
    assert.equal(defaulted.invocation.persist, "@bluewombat/persist-fs");

    writeFileSync(config, stringifyYaml(configOf(dir, { persist: "@bluewombat/persist-sqlite" })));
    const fromConfig = parseArgs(["--config", config], { cwd: dir.root });
    assert.ok(fromConfig.ok);
    assert.equal(fromConfig.invocation.persist, "@bluewombat/persist-sqlite");

    const fromFlag = parseArgs(["--config", config, "--persist", "./my-persist.mjs"], {
      cwd: dir.root,
    });
    assert.ok(fromFlag.ok);
    assert.equal(fromFlag.invocation.persist, "./my-persist.mjs");

    const empty = parseArgs(["--config", config, "--persist", ""], { cwd: dir.root });
    assert.ok(!empty.ok);
    assert.match(empty.reason, /--persist must be a non-empty package name or path/);
  });

  it("carries the budgets from the config", () => {
    const dir = dirs();
    writeFileSync(
      join(dir.root, CONFIG_FILENAME),
      stringifyYaml({
        ...configOf(dir),
        builder: {
          producer: { cmd: [node, builder], timeoutMs: 60_000 },
          repair: { cmd: [node, builder], timeoutMs: 60_000 },
          maxAttempts: 5,
        },
        maxRefusals: 2,
      }),
    );
    const parsed = parseArgs(["--config", join(dir.root, CONFIG_FILENAME)], { cwd: dir.root });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) {
      return;
    }
    assert.equal(parsed.invocation.builder.maxAttempts, 5);
    assert.equal(parsed.invocation.builder.producer.timeoutMs, 60_000);
    assert.equal(parsed.invocation.maxRefusals, 2);
  });

  it("reads a separate Gate sequence for the assembled feature", () => {
    const dir = dirs();
    writeFileSync(
      join(dir.root, CONFIG_FILENAME),
      stringifyYaml({
        ...configOf(dir),
        builder: {
          producer: { cmd: [node, builder], timeoutMs: 600_000 },
          repair: { cmd: [node, builder], timeoutMs: 600_000 },
          gates: {
            defaultTimeoutMs: 60_000,
            gates: [{ id: "unit", argv: ["node", "gate.mjs"] }],
          },
        },
        assembly: {
          gates: {
            defaultTimeoutMs: 900_000,
            gates: [{ id: "whole", argv: ["node", "gate.mjs"] }],
          },
        },
      }),
    );
    const parsed = parseArgs(["--config", join(dir.root, CONFIG_FILENAME)], { cwd: dir.root });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) {
      return;
    }
    assert.equal(parsed.invocation.builder.gates[0]?.id, "unit");
    assert.equal(parsed.invocation.assembly.gates[0]?.id, "whole");
  });

  it("reads the Authority block and resolves its Publisher against the config", () => {
    const dir = dirs();
    // A relative token becomes a path only when it is one: same rule as a Gate.
    writeFileSync(join(dir.root, "publish.mjs"), "");
    writeFileSync(
      join(dir.root, CONFIG_FILENAME),
      stringifyYaml({
        ...configOf(dir),
        authority: {
          enabled: true,
          publish: ["node", "./publish.mjs"],
          refresh: ["node", "./publish.mjs"],
        },
      }),
    );
    const parsed = parseArgs(["--config", join(dir.root, CONFIG_FILENAME)], { cwd: dir.root });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) {
      return;
    }
    assert.equal(parsed.invocation.authority?.enabled, true);
    assert.equal(parsed.invocation.authority?.publishArgv[1], join(dir.root, "publish.mjs"));
    assert.equal(parsed.invocation.authority?.describeArgv, undefined);
  });

  it("reads the optional Describer of the Authority, and refuses an empty one", () => {
    const dir = dirs();
    writeFileSync(join(dir.root, "publish.mjs"), "");
    writeFileSync(join(dir.root, "describe.mjs"), "");
    const config = join(dir.root, CONFIG_FILENAME);
    const authority = {
      enabled: true,
      publish: ["node", "./publish.mjs"],
      refresh: ["node", "./publish.mjs"],
    };
    writeFileSync(
      config,
      stringifyYaml({
        ...configOf(dir),
        authority: { ...authority, describe: ["node", "./describe.mjs", "--scope", "api"] },
      }),
    );
    const parsed = parseArgs(["--config", config], { cwd: dir.root });
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.invocation.authority?.describeArgv, [
      "node",
      join(dir.root, "describe.mjs"),
      "--scope",
      "api",
    ]);

    writeFileSync(
      config,
      stringifyYaml({ ...configOf(dir), authority: { ...authority, describe: [] } }),
    );
    const empty = parseArgs(["--config", config], { cwd: dir.root });
    assert.ok(!empty.ok);
    assert.match(empty.reason, /authority\.describe/);
  });

  it("refuses an Authority that is enabled and names neither slot", () => {
    // Enabled with no Publisher is a Project that cannot submit anything, and
    // with no Refresher it builds every next feature on a version the Authority
    // has already moved past. Say so here, not hours later.
    const dir = dirs();
    writeFileSync(
      join(dir.root, CONFIG_FILENAME),
      stringifyYaml({ ...configOf(dir), authority: { enabled: true } }),
    );
    const parsed = parseArgs(["--config", join(dir.root, CONFIG_FILENAME)], { cwd: dir.root });
    assert.equal(parsed.ok, false);
    assert.match(parsed.ok === false ? parsed.reason : "", /authority\.publish/);
  });

  it("takes an Authority turned off with no Publisher named", () => {
    const dir = dirs();
    writeFileSync(
      join(dir.root, CONFIG_FILENAME),
      stringifyYaml({ ...configOf(dir), authority: { enabled: false } }),
    );
    const parsed = parseArgs(["--config", join(dir.root, CONFIG_FILENAME)], { cwd: dir.root });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) {
      return;
    }
    assert.equal(parsed.invocation.authority?.enabled, false);
  });

  it("reads assembly.fix, and says why assembly has no producer or repair", () => {
    const dir = dirs();
    writeFileSync(
      join(dir.root, CONFIG_FILENAME),
      stringifyYaml({
        ...configOf(dir),
        assembly: {
          fix: { cmd: [node, builder], timeoutMs: 60_000 },
          maxAttempts: 2,
        },
      }),
    );
    const parsed = parseArgs(["--config", join(dir.root, CONFIG_FILENAME)], { cwd: dir.root });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) {
      return;
    }
    assert.deepEqual(parsed.invocation.assembly.fix?.cmd, [node, builder]);
    assert.equal(parsed.invocation.assembly.fix?.timeoutMs, 60_000);
    assert.equal(parsed.invocation.assembly.maxAttempts, 2);

    writeFileSync(
      join(dir.root, CONFIG_FILENAME),
      stringifyYaml({
        ...configOf(dir),
        assembly: {
          producer: { cmd: [node, builder], timeoutMs: 60_000 },
          repair: { cmd: [node, builder], timeoutMs: 60_000 },
        },
      }),
    );
    const refused = parseArgs(["--config", join(dir.root, CONFIG_FILENAME)], { cwd: dir.root });
    assert.equal(refused.ok, false);
    assert.match(refused.ok === false ? refused.reason : "", /assembly\.fix/);
  });

  it("reads assembly.validate from the config, beside assembly.fix", () => {
    const dir = dirs();
    writeFileSync(
      join(dir.root, CONFIG_FILENAME),
      stringifyYaml({
        ...configOf(dir),
        assembly: {
          fix: { cmd: [node, builder], timeoutMs: 60_000 },
          validate: { cmd: [node, builder, "--review"], timeoutMs: 30_000 },
        },
      }),
    );
    const parsed = parseArgs(["--config", join(dir.root, CONFIG_FILENAME)], { cwd: dir.root });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) {
      return;
    }
    assert.deepEqual(parsed.invocation.assembly.validate?.cmd, [node, builder, "--review"]);
    assert.equal(parsed.invocation.assembly.validate?.timeoutMs, 30_000);
    assert.equal(parsed.invocation.assembly.fix?.cmd[0], node);
  });

  it("--assembly-validate sets the command and timeout, alongside --assembly-fix", () => {
    const dir = dirs();
    const parsed = parseArgs(
      [
        "--manager",
        "@bluewombat/manager-github",
        ...paths(dir),
        ...slots(),
        "--assembly-fix",
        "--",
        node,
        builder,
        "--assembly-fix-timeout-ms",
        "60000",
        "--assembly-validate",
        "--",
        node,
        builder,
        "--review",
        "--assembly-validate-timeout-ms",
        "30000",
      ],
      { cwd: dir.root },
    );
    assert.equal(parsed.ok, true);
    if (!parsed.ok) {
      return;
    }
    assert.deepEqual(parsed.invocation.assembly.validate?.cmd, [node, builder, "--review"]);
    assert.equal(parsed.invocation.assembly.validate?.timeoutMs, 30_000);
    assert.deepEqual(parsed.invocation.assembly.fix?.cmd, [node, builder]);
  });

  it("puts the ledger, the workspaces and home under .mason by the config unless told otherwise", () => {
    const dir = dirs();
    const { workspaceRoot: _w, ledger: _l, ...config } = configOf(dir);
    writeFileSync(join(dir.root, CONFIG_FILENAME), stringifyYaml(config));
    const parsed = parseArgs(["--config", join(dir.root, CONFIG_FILENAME)], { cwd: dir.root });
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.invocation.home, join(dir.root, ".mason"));
      assert.equal(parsed.invocation.workspaceRoot, join(dir.root, ".mason", "workspaces"));
      assert.equal(parsed.invocation.ledgerRoot, join(dir.root, ".mason", "ledger"));
    }
  });

  it("moves everything with home, and one part alone with its own key", () => {
    const dir = dirs();
    const { workspaceRoot: _w, ledger: _l, ...config } = configOf(dir);
    writeFileSync(
      join(dir.root, CONFIG_FILENAME),
      stringifyYaml({ ...config, home: "./var", ledger: "./elsewhere/ledger" }),
    );
    const parsed = parseArgs(
      ["--config", join(dir.root, CONFIG_FILENAME), "--workspace-root", "./scratch"],
      { cwd: dir.root },
    );
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.invocation.home, join(dir.root, "var"));
      assert.equal(parsed.invocation.workspaceRoot, join(dir.root, "scratch"));
      assert.equal(parsed.invocation.ledgerRoot, join(dir.root, "elsewhere", "ledger"));
    }
  });

  it("refuses a config file that is not valid YAML", () => {
    const dir = dirs();
    writeFileSync(join(dir.root, CONFIG_FILENAME), "manager: [unterminated\n");
    const parsed = parseArgs(["--config", join(dir.root, CONFIG_FILENAME)], { cwd: dir.root });
    assert.equal(parsed.ok, false);
    if (!parsed.ok) {
      assert.match(parsed.reason, /not valid YAML/);
    }
  });

  it("refuses a config with a repeated key rather than keeping the last one", () => {
    const dir = dirs();
    writeFileSync(
      join(dir.root, CONFIG_FILENAME),
      "manager: @bluewombat/manager-fake\nmanager: @bluewombat/manager-github\n",
    );
    const parsed = parseArgs(["--config", join(dir.root, CONFIG_FILENAME)], { cwd: dir.root });
    assert.equal(parsed.ok, false);
    if (!parsed.ok) {
      assert.match(parsed.reason, /not valid YAML/);
    }
  });

  it("refuses an unquoted npm-scoped value: @ is a reserved YAML indicator", () => {
    const dir = dirs();
    writeFileSync(join(dir.root, CONFIG_FILENAME), "manager: @bluewombat/manager-github\n");
    const parsed = parseArgs(["--config", join(dir.root, CONFIG_FILENAME)], { cwd: dir.root });
    assert.equal(parsed.ok, false);
    if (!parsed.ok) {
      assert.match(parsed.reason, /not valid YAML/);
    }
  });

  it("refuses a config that is a YAML scalar or sequence, not a mapping", () => {
    const dir = dirs();
    writeFileSync(join(dir.root, CONFIG_FILENAME), '- manager\n- "@bluewombat/manager-fake"\n');
    const parsed = parseArgs(["--config", join(dir.root, CONFIG_FILENAME)], { cwd: dir.root });
    assert.equal(parsed.ok, false);
    if (!parsed.ok) {
      assert.match(parsed.reason, /YAML mapping/);
    }
  });

  it("keeps YAML 1.1-looking scalars as plain strings, hand-written and unquoted", () => {
    const dir = dirs();
    // Written by hand, not through `stringifyYaml`, so this proves a human
    // can write `no` / `on` unquoted and still get the string back: the
    // `yaml` package defaults to the YAML 1.2 core schema, not 1.1's
    // yes/no/on/off booleans. The `@bluewombat/...` values stay quoted: `@`
    // is a reserved indicator at the start of a plain YAML scalar.
    writeFileSync(
      join(dir.root, CONFIG_FILENAME),
      [
        'manager: "@bluewombat/manager-github"',
        "workLine:",
        `  stable: ${dir.workLineStable}`,
        '  isolation: "@bluewombat/isolation-copy"',
        "managerOptions:",
        "  repo: tilap/mason",
        "  defaultProject: no",
        "  readyLabel: on",
        `planner: { cmd: [${node}, ${planner}], timeoutMs: 600000 }`,
        `builder:`,
        `  producer: { cmd: [${node}, ${builder}], timeoutMs: 600000 }`,
        `  repair: { cmd: [${node}, ${builder}], timeoutMs: 600000 }`,
        "timeoutMs: 1000",
      ].join("\n"),
    );
    const parsed = parseArgs(["--config", join(dir.root, CONFIG_FILENAME)], { cwd: dir.root });
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.deepEqual(parsed.invocation.managerOptions, {
        repo: "tilap/mason",
        defaultProject: "no",
        readyLabel: "on",
      });
    }
  });
});
