import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { stringify as stringifyYaml } from "yaml";
import { agentPartOf } from "./agent-shorthand.js";
import { loadConfig } from "./load-config.js";
import { hasAgent } from "./types.js";

function load(config: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "host-shorthand-"));
  const file = join(dir, "mason.config.yaml");
  writeFileSync(file, stringifyYaml(config));
  return { dir, loaded: loadConfig(file) };
}

const cursorAgent = {
  adapter: "cursor",
  home: "./.mason/agent-home",
  apiKeyEnv: "CURSOR_API_KEY",
  transcripts: "./.mason/transcripts",
  pluginsOut: "./.mason/plugins",
};

describe("agent passes written short", () => {
  it("expands every role into the argv a pass has always been", () => {
    const { dir, loaded } = load({
      agents: { cursor: cursorAgent },
      builder: {
        producer: {
          agent: "cursor",
          prompt: "./prompts/builder.md",
          homePlugins: ["./ai-plugins/core/builder"],
          appDeckProfile: ".ai/profiles/builder",
          args: ["--plan"],
          timeoutMs: 1200000,
        },
        repair: { agent: "cursor", prompt: "./prompts/builder-repair.md", timeoutMs: 1200000 },
      },
      ticket: {
        fix: { agent: "cursor", timeoutMs: 600000 },
        validate: { agent: "cursor", args: ["--mode", "ask"], timeoutMs: 600000 },
      },
      feature: {
        fix: { agent: "cursor", timeoutMs: 600000 },
        validate: {
          agent: "cursor",
          timeoutMs: 600000,
          gates: { gates: [{ id: "tests", argv: ["node", "tests.mjs"], timeoutMs: 1000 }] },
        },
        gates: { gates: [{ id: "check", argv: ["node", "check.mjs"], timeoutMs: 1000 }] },
      },
      authority: {
        enabled: true,
        publish: ["node", "publish.mjs"],
        refresh: ["node", "refresh.mjs"],
        describe: { agent: "cursor" },
      },
    });
    assert.equal(loaded.ok, true, loaded.ok ? "" : loaded.reason);
    if (!loaded.ok) {
      return;
    }
    const slots = join(dir, "node_modules/@bluewombat/slots");
    const agentHead = [
      "--",
      "node",
      join(slots, "agents/cursor.mjs"),
      "--transcript-dir",
      join(dir, ".mason/transcripts"),
      "--agent-home",
      join(dir, ".mason/agent-home"),
      "--api-key-env",
      "CURSOR_API_KEY",
    ];
    const invocation = loaded.invocation;
    assert.deepEqual(invocation.builder?.producer.cmd, [
      "node",
      join(slots, "builders/producer.mjs"),
      "--prompt-file",
      join(dir, "prompts/builder.md"),
      ...agentHead,
      "--plugin-dir",
      join(dir, "ai-plugins/core/builder"),
      "--app-deck-profile",
      ".ai/profiles/builder",
      "--plugins-out",
      join(dir, ".mason/plugins"),
      "--agent-arg",
      "--plan",
    ]);
    assert.equal(invocation.builder?.producer.timeoutMs, 1200000);
    assert.deepEqual(invocation.builder?.repair.cmd.slice(0, 4), [
      "node",
      join(slots, "builders/repair.mjs"),
      "--prompt-file",
      join(dir, "prompts/builder-repair.md"),
    ]);
    assert.equal(invocation.ticket?.fix?.cmd[1], join(slots, "ticket/fix.mjs"));
    const validate = invocation.ticket?.validate;
    assert.ok(validate !== undefined && hasAgent(validate));
    assert.deepEqual(validate.cmd.slice(-4), ["--agent-arg", "--mode", "--agent-arg", "ask"]);
    assert.deepEqual(invocation.authority?.describeArgv, [
      "node",
      join(slots, "messages/git-producer.mjs"),
      ...agentHead,
    ]);
    assert.deepEqual(agentPartOf(invocation.builder?.producer.cmd ?? []), {
      appDeckProfile: ".ai/profiles/builder",
      pluginsOut: join(dir, ".mason/plugins"),
      pluginDirs: [join(dir, "ai-plugins/core/builder")],
    });
  });

  it("keeps cmd as it was, and resolves --plugin-dir and --plugins-out next to the config", () => {
    const { dir, loaded } = load({
      builder: {
        producer: {
          cmd: [
            "node",
            "x.mjs",
            "--",
            "node",
            "a.mjs",
            "--plugin-dir",
            "./p",
            "--plugins-out",
            "./o",
          ],
          timeoutMs: 1000,
        },
        repair: { cmd: ["node", "r.mjs"], timeoutMs: 1000 },
      },
    });
    assert.equal(loaded.ok, true, loaded.ok ? "" : loaded.reason);
    if (loaded.ok) {
      assert.deepEqual(loaded.invocation.builder?.producer.cmd.slice(-4), [
        "--plugin-dir",
        join(dir, "p"),
        "--plugins-out",
        join(dir, "o"),
      ]);
    }
  });

  it("refuses a pass that names both cmd and agent", () => {
    const { loaded } = load({
      agents: { cursor: cursorAgent },
      builder: {
        producer: { agent: "cursor", cmd: ["node", "x.mjs"], timeoutMs: 1000 },
        repair: { cmd: ["node", "r.mjs"], timeoutMs: 1000 },
      },
    });
    assert.equal(loaded.ok, false);
    assert.match(loaded.ok ? "" : loaded.reason, /names "cmd" and "agent"/);
  });

  it("refuses an agent that agents does not declare", () => {
    const { loaded } = load({
      builder: {
        producer: { agent: "cursor", timeoutMs: 1000 },
        repair: { cmd: ["node", "r.mjs"], timeoutMs: 1000 },
      },
    });
    assert.equal(loaded.ok, false);
    assert.match(loaded.ok ? "" : loaded.reason, /declares no such agent/);
  });

  it("refuses read, and a short key on a cmd pass", () => {
    const read = load({
      agents: { cursor: cursorAgent },
      builder: {
        producer: { agent: "cursor", read: "./x", timeoutMs: 1000 },
        repair: { agent: "cursor", timeoutMs: 1000 },
      },
    });
    assert.equal(read.loaded.ok, false);
    assert.match(
      read.loaded.ok ? "" : read.loaded.reason,
      /"builder.producer" has unknown key "read"/,
    );
    const profile = load({
      builder: {
        producer: { cmd: ["node", "x.mjs"], appDeckProfile: ".ai/profiles/p", timeoutMs: 1000 },
        repair: { cmd: ["node", "r.mjs"], timeoutMs: 1000 },
      },
    });
    assert.equal(profile.loaded.ok, false);
    assert.match(profile.loaded.ok ? "" : profile.loaded.reason, /unknown key "appDeckProfile"/);
  });

  it("refuses a profile when the agent has nowhere to build it", () => {
    const { loaded } = load({
      agents: { cursor: { adapter: "cursor" } },
      builder: {
        producer: { agent: "cursor", appDeckProfile: ".ai/profiles/builder", timeoutMs: 1000 },
        repair: { cmd: ["node", "r.mjs"], timeoutMs: 1000 },
      },
    });
    assert.equal(loaded.ok, false);
    assert.match(loaded.ok ? "" : loaded.reason, /pluginsOut/);
  });

  it("refuses an agent half isolated, or with no adapter", () => {
    const half = load({ agents: { cursor: { adapter: "cursor", home: "./h" } } });
    assert.equal(half.loaded.ok, false);
    assert.match(half.loaded.ok ? "" : half.loaded.reason, /"home" and "apiKeyEnv" together/);
    const bare = load({ agents: { cursor: { home: "./h" } } });
    assert.equal(bare.loaded.ok, false);
    assert.match(bare.loaded.ok ? "" : bare.loaded.reason, /needs an "adapter"/);
  });

  it("passes the environment variables and denied commands an agent names to its adapter", () => {
    const { loaded } = load({
      agents: {
        cursor: {
          ...cursorAgent,
          passEnv: ["DATABASE_URL", "AUTH_SECRET"],
          denyShell: ["gh", "vercel"],
        },
      },
      builder: {
        producer: { agent: "cursor", prompt: "./prompts/builder.md", timeoutMs: 600000 },
        repair: { cmd: ["node", "r.mjs"], timeoutMs: 1000 },
      },
    });
    assert.equal(loaded.ok, true, loaded.ok ? "" : loaded.reason);
    const cmd = loaded.ok ? (loaded.invocation.builder?.producer.cmd ?? []) : [];
    const at = cmd.indexOf("--api-key-env");
    assert.deepEqual(cmd.slice(at, at + 10), [
      "--api-key-env",
      "CURSOR_API_KEY",
      "--pass-env",
      "DATABASE_URL",
      "--pass-env",
      "AUTH_SECRET",
      "--deny-shell",
      "gh",
      "--deny-shell",
      "vercel",
    ]);
  });

  it("refuses passEnv and denyShell on an agent that is not isolated, or that is not a list of strings", () => {
    const open = load({ agents: { cursor: { adapter: "cursor", passEnv: ["A"] } } });
    assert.equal(open.loaded.ok, false);
    assert.match(open.loaded.ok ? "" : open.loaded.reason, /passEnv.*isolated agent/);
    const openDeny = load({ agents: { cursor: { adapter: "cursor", denyShell: ["gh"] } } });
    assert.equal(openDeny.loaded.ok, false);
    assert.match(openDeny.loaded.ok ? "" : openDeny.loaded.reason, /denyShell.*isolated agent/);
    const wrong = load({ agents: { cursor: { ...cursorAgent, passEnv: "A" } } });
    assert.equal(wrong.loaded.ok, false);
    assert.match(
      wrong.loaded.ok ? "" : wrong.loaded.reason,
      /passEnv" must be an array of strings/,
    );
  });
});
