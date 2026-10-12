import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const node = process.execPath;
const here = dirname(fileURLToPath(import.meta.url));
const cursor = join(here, "../agents/cursor.mjs");
const claude = join(here, "../agents/claude.mjs");
const fixtures = join(here, "../fixtures");
const agentEchoArgv = join(fixtures, "agent-echo-argv.mjs");
const streamSkills = join(fixtures, "cursor-stream-skills.jsonl");

function sandbox() {
  return mkdtempSync(join(tmpdir(), "mason-agent-"));
}

function lastPayload(stdout: string): Record<string, unknown> {
  const last = stdout.trim().split("\n").filter(Boolean).at(-1);
  assert.ok(last !== undefined);
  return JSON.parse(last) as Record<string, unknown>;
}

/** Parent env for an isolated run: this process's env, with a chosen HOME and no inherited cache pointers. */
function parentEnv(parentHome: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: parentHome };
  delete env.GIT_CONFIG_GLOBAL;
  delete env.COREPACK_HOME;
  delete env.npm_config_cache;
  delete env.XDG_CONFIG_HOME;
  delete env.AGENT_CLI_CREDENTIAL_STORE;
  return { ...env, ...extra };
}

function readPickedEnv(cwd: string): Record<string, string> {
  return JSON.parse(readFileSync(join(cwd, "env.json"), "utf8")) as Record<string, string>;
}

describe("cursor agent", () => {
  it("passes --prompt through without interpolating", () => {
    const cwd = sandbox();
    const result = spawnSync(
      node,
      [cursor, "--bin", agentEchoArgv, "--prompt", "raw {{task}} text"],
      { cwd, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const argv = JSON.parse(readFileSync(join(cwd, "argv.json"), "utf8")) as string[];
    assert.equal(argv.at(-1), "raw {{task}} text");
    const payload = lastPayload(result.stdout);
    assert.equal(payload.name, "Cursor CLI");
    assert.equal(payload.code, 0);
    // Echo fixture is one result line: parsed, no skill reads → [] not null.
    assert.deepEqual(payload.skills, []);
    assert.equal(payload.usage, null);
  });

  it("defaults to stream-json so tool events can be read", () => {
    const cwd = sandbox();
    const result = spawnSync(node, [cursor, "--bin", agentEchoArgv, "--prompt", "hi"], {
      cwd,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const argv = JSON.parse(readFileSync(join(cwd, "argv.json"), "utf8")) as string[];
    const formatAt = argv.indexOf("--output-format");
    assert.notEqual(formatAt, -1);
    assert.equal(argv[formatAt + 1], "stream-json");
  });

  it("puts skills and usage on the serialized line from stream-json stdout", () => {
    const cwd = sandbox();
    const fakeVendor = join(cwd, "vendor.mjs");
    const body = readFileSync(streamSkills, "utf8");
    writeFileSync(
      fakeVendor,
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync("argv.json", JSON.stringify(process.argv.slice(2)));
process.stdout.write(${JSON.stringify(body)});
`,
      { mode: 0o755 },
    );
    const result = spawnSync(node, [cursor, "--bin", fakeVendor, "--prompt", "hi"], {
      cwd,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const payload = lastPayload(result.stdout);
    assert.deepEqual(payload.skills, ["thin-slice"]);
    assert.deepEqual(payload.usage, {
      input: 10077,
      output: 436,
      cacheRead: 26624,
      cacheWrite: 0,
      costUsd: null,
    });
  });

  it("delivers a large serialized run after process.exit", () => {
    // stream-json transcripts are tens to hundreds of KiB; serializeRun embeds
    // stdout twice. writeContract must land the whole line before exit.
    const cwd = sandbox();
    const fakeVendor = join(cwd, "vendor.mjs");
    const blob = `${'{"type":"thinking","text":"x"}\n'.repeat(2_000)}{"type":"result","subtype":"success","is_error":false,"result":"ok","usage":{"inputTokens":1,"outputTokens":1,"cacheReadTokens":0,"cacheWriteTokens":0}}\n`;
    writeFileSync(
      fakeVendor,
      `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(blob)});
`,
      { mode: 0o755 },
    );
    const result = spawnSync(node, [cursor, "--bin", fakeVendor, "--prompt", "hi"], {
      cwd,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    assert.equal(result.status, 0, result.stderr);
    const payload = lastPayload(result.stdout);
    assert.equal(payload.name, "Cursor CLI");
    assert.equal(typeof payload.stdout, "string");
    assert.ok((payload.stdout as string).length > 16_000);
    assert.equal(payload.code, 0);
  });

  it("leaves skills unknown when --output-format is json", () => {
    const cwd = sandbox();
    const fakeVendor = join(cwd, "vendor.mjs");
    const body = readFileSync(streamSkills, "utf8");
    writeFileSync(
      fakeVendor,
      `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(body)});
`,
      { mode: 0o755 },
    );
    const result = spawnSync(
      node,
      [cursor, "--bin", fakeVendor, "--output-format", "json", "--prompt", "hi"],
      { cwd, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const payload = lastPayload(result.stdout);
    assert.equal(payload.skills, null);
  });

  it("reads --prompt-file as the same raw text", () => {
    const cwd = sandbox();
    const file = join(cwd, "p.md");
    writeFileSync(file, "from file {{report}}");
    const result = spawnSync(node, [cursor, "--bin", agentEchoArgv, "--prompt-file", file], {
      cwd,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const argv = JSON.parse(readFileSync(join(cwd, "argv.json"), "utf8")) as string[];
    assert.equal(argv.at(-1), "from file {{report}}");
  });

  it("refuses when neither prompt is given", () => {
    const cwd = sandbox();
    const result = spawnSync(node, [cursor, "--bin", agentEchoArgv], { cwd, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    const payload = JSON.parse(result.stdout.trim()) as { error: string };
    assert.match(payload.error, /--prompt or --prompt-file/);
  });

  it("does not force HOME when --agent-home is absent", () => {
    const cwd = sandbox();
    const parentHome = sandbox();
    const result = spawnSync(node, [cursor, "--bin", agentEchoArgv, "--prompt", "hi"], {
      cwd,
      encoding: "utf8",
      env: parentEnv(parentHome),
    });
    assert.equal(result.status, 0, result.stderr);
    const env = readPickedEnv(cwd);
    assert.equal(env.HOME, parentHome);
    assert.equal(env.AGENT_CLI_CREDENTIAL_STORE, undefined);
    const argv = JSON.parse(readFileSync(join(cwd, "argv.json"), "utf8")) as string[];
    assert.ok(argv.includes("--force"));
    assert.ok(argv.includes("--trust"));
  });

  it("refuses an isolated run when the named key is missing, and does not start the vendor", () => {
    const cwd = sandbox();
    const result = spawnSync(
      node,
      [
        cursor,
        "--bin",
        agentEchoArgv,
        "--prompt",
        "hi",
        "--agent-home",
        join(cwd, ".mason", "agent-home"),
        "--api-key-env",
        "MASON_TEST_AGENT_KEY",
      ],
      { cwd, encoding: "utf8", env: parentEnv(sandbox()) },
    );
    assert.notEqual(result.status, 0);
    const payload = JSON.parse(result.stdout.trim()) as { error: string };
    assert.match(payload.error, /MASON_TEST_AGENT_KEY/);
    assert.equal(existsSync(join(cwd, "argv.json")), false);
  });

  it("refuses an isolated run when the named key is empty", () => {
    const cwd = sandbox();
    const result = spawnSync(
      node,
      [
        cursor,
        "--bin",
        agentEchoArgv,
        "--prompt",
        "hi",
        "--agent-home",
        join(cwd, "agent-home"),
        "--api-key-env",
        "MASON_TEST_AGENT_KEY",
      ],
      { cwd, encoding: "utf8", env: parentEnv(sandbox(), { MASON_TEST_AGENT_KEY: "" }) },
    );
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(join(cwd, "argv.json")), false);
  });

  it("isolates the vendor process and keeps the parent's git, npm, and corepack paths", () => {
    const cwd = sandbox();
    const parentHome = sandbox();
    mkdirSync(join(parentHome, ".cache", "node", "corepack"), { recursive: true });
    writeFileSync(join(parentHome, ".gitconfig"), "[user]\n\tname = Operator\n");
    const agentHome = join(realpathSync(cwd), ".mason", "agent-home");
    const result = spawnSync(
      node,
      [
        cursor,
        "--bin",
        agentEchoArgv,
        "--prompt",
        "hi",
        "--agent-home",
        "./.mason/agent-home",
        "--api-key-env",
        "MASON_TEST_AGENT_KEY",
      ],
      {
        cwd,
        encoding: "utf8",
        env: parentEnv(parentHome, { MASON_TEST_AGENT_KEY: "test-key-not-real" }),
      },
    );
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const env = readPickedEnv(cwd);
    assert.equal(env.HOME, agentHome);
    assert.equal(env.AGENT_CLI_CREDENTIAL_STORE, "memory");
    assert.equal(env.CURSOR_API_KEY, "test-key-not-real");
    assert.equal(env.COREPACK_HOME, join(parentHome, ".cache", "node", "corepack"));
    assert.equal(env.GIT_CONFIG_GLOBAL, join(parentHome, ".gitconfig"));
    assert.equal(env.npm_config_cache, join(parentHome, ".npm"));
    assert.equal(env.PATH, process.env.PATH);
    assert.equal(existsSync(agentHome), true);
    const argv = JSON.parse(readFileSync(join(cwd, "argv.json"), "utf8")) as string[];
    assert.deepEqual(argv.slice(0, 7), [
      "-p",
      "--force",
      "--trust",
      "--workspace",
      realpathSync(cwd),
      "--sandbox",
      "disabled",
    ]);
    assert.equal(argv.includes("test-key-not-real"), false);
  });

  function isolatedRun(
    cwd: string,
    parentHome: string,
    extraArgs: string[],
    extraEnv: Record<string, string>,
  ) {
    return spawnSync(
      node,
      [
        cursor,
        "--bin",
        agentEchoArgv,
        "--prompt",
        "hi",
        "--agent-home",
        join(cwd, "agent-home"),
        "--api-key-env",
        "MASON_TEST_AGENT_KEY",
        ...extraArgs,
      ],
      {
        cwd,
        encoding: "utf8",
        env: parentEnv(parentHome, { MASON_TEST_AGENT_KEY: "test-key-not-real", ...extraEnv }),
      },
    );
  }

  it("hands the vendor a short environment, not the operator's", () => {
    const cwd = sandbox();
    const result = isolatedRun(cwd, sandbox(), [], {
      LANG: "C.UTF-8",
      SSH_AUTH_SOCK: "/tmp/operator-agent.sock",
      MASON_TEST_SECRET: "operator-token",
    });
    assert.equal(result.status, 0, result.stderr);
    const env = readPickedEnv(cwd);
    assert.equal(env.LANG, "C.UTF-8");
    assert.equal(env.PATH, process.env.PATH);
    assert.equal(env.SSH_AUTH_SOCK, undefined);
    assert.equal(env.MASON_TEST_SECRET, undefined);
  });

  it("--pass-env hands the vendor one more variable, and refuses a name that is not one", () => {
    const cwd = sandbox();
    const passed = isolatedRun(cwd, sandbox(), ["--pass-env", "MASON_TEST_PASS"], {
      MASON_TEST_PASS: "wanted",
      MASON_TEST_SECRET: "operator-token",
    });
    assert.equal(passed.status, 0, passed.stderr);
    const env = readPickedEnv(cwd);
    assert.equal(env.MASON_TEST_PASS, "wanted");
    assert.equal(env.MASON_TEST_SECRET, undefined);

    const other = sandbox();
    const refused = isolatedRun(other, sandbox(), ["--pass-env", "not a name"], {});
    assert.notEqual(refused.status, 0);
    assert.match((JSON.parse(refused.stdout.trim()) as { error: string }).error, /--pass-env/);
    assert.equal(existsSync(join(other, "argv.json")), false);
  });

  it("clears the operator's git credential helpers for the vendor", () => {
    const cwd = sandbox();
    const result = isolatedRun(cwd, sandbox(), [], {});
    assert.equal(result.status, 0, result.stderr);
    const env = readPickedEnv(cwd);
    assert.equal(env.GIT_CONFIG_COUNT, "1");
    assert.equal(env.GIT_CONFIG_KEY_0, "credential.helper");
    assert.equal(env.GIT_CONFIG_VALUE_0, "");
    assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  });

  it("denies the credential-carrying tools in the vendor's config, keeping what else is there", () => {
    const cwd = sandbox();
    const configFile = join(cwd, "agent-home", ".cursor", "cli-config.json");
    mkdirSync(dirname(configFile), { recursive: true });
    writeFileSync(
      configFile,
      JSON.stringify({
        version: 7,
        model: "kept",
        permissions: { allow: ["Shell(ls)"], deny: ["Shell(rm)"] },
      }),
    );
    for (const _ of [1, 2]) {
      const result = isolatedRun(cwd, sandbox(), [], {});
      assert.equal(result.status, 0, result.stderr);
    }
    const config = JSON.parse(readFileSync(configFile, "utf8")) as {
      version: number;
      model: string;
      permissions: { allow: string[]; deny: string[] };
    };
    assert.equal(config.version, 7);
    assert.equal(config.model, "kept");
    assert.deepEqual(config.permissions.allow, ["Shell(ls)"]);
    assert.deepEqual(config.permissions.deny, ["Shell(rm)", "Shell(ssh)", "Shell(scp)"]);
  });

  it("--deny-shell adds the Project's own commands, and refuses a name that is not one", () => {
    const cwd = sandbox();
    const added = isolatedRun(cwd, sandbox(), ["--deny-shell", "gh", "--deny-shell", "vercel"], {});
    assert.equal(added.status, 0, added.stderr);
    const config = JSON.parse(
      readFileSync(join(cwd, "agent-home", ".cursor", "cli-config.json"), "utf8"),
    ) as { permissions: { deny: string[] } };
    assert.deepEqual(config.permissions.deny, [
      "Shell(ssh)",
      "Shell(scp)",
      "Shell(gh)",
      "Shell(vercel)",
    ]);

    const other = sandbox();
    const refused = isolatedRun(other, sandbox(), ["--deny-shell", "gh;rm"], {});
    assert.notEqual(refused.status, 0);
    assert.match((JSON.parse(refused.stdout.trim()) as { error: string }).error, /--deny-shell/);
    assert.equal(existsSync(join(other, "argv.json")), false);
  });

  it("writes the denials when the vendor has no config yet", () => {
    const cwd = sandbox();
    const result = isolatedRun(cwd, sandbox(), [], {});
    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(
      readFileSync(join(cwd, "agent-home", ".cursor", "cli-config.json"), "utf8"),
    ) as { permissions: { allow: string[]; deny: string[] } };
    assert.deepEqual(config.permissions.allow, []);
    assert.deepEqual(config.permissions.deny, ["Shell(ssh)", "Shell(scp)"]);
  });

  it("omits git and corepack redirects when the parent has neither", () => {
    const cwd = sandbox();
    const parentHome = sandbox();
    const result = spawnSync(
      node,
      [
        cursor,
        "--bin",
        agentEchoArgv,
        "--prompt",
        "hi",
        "--agent-home",
        join(cwd, "agent-home"),
        "--api-key-env",
        "MASON_TEST_AGENT_KEY",
      ],
      {
        cwd,
        encoding: "utf8",
        env: parentEnv(parentHome, { MASON_TEST_AGENT_KEY: "test-key-not-real" }),
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const env = readPickedEnv(cwd);
    assert.equal(env.GIT_CONFIG_GLOBAL, undefined);
    assert.equal(env.COREPACK_HOME, undefined);
    assert.equal(env.npm_config_cache, join(parentHome, ".npm"));
  });
});

describe("agent plugin folders", () => {
  const deckFake = join(fixtures, "deck-fake.mjs");

  function localPlugin(root: string, name: string): string {
    const dir = join(root, "home", "ai-plugins", name);
    mkdirSync(join(dir, ".cursor-plugin"), { recursive: true });
    writeFileSync(join(dir, "plugin.json"), JSON.stringify({ name: `core-${name}` }));
    return dir;
  }

  function project(root: string, { base, profile }: { base: boolean; profile?: string }): string {
    const cwd = join(root, "workspace");
    mkdirSync(cwd, { recursive: true });
    if (base) {
      writeFileSync(join(cwd, "ai-plugin.json"), JSON.stringify({ plugins: [] }));
    }
    if (profile !== undefined) {
      mkdirSync(join(cwd, ".ai", "profiles", profile), { recursive: true });
      writeFileSync(
        join(cwd, ".ai", "profiles", profile, "ai-plugin.json"),
        JSON.stringify({ plugins: [] }),
      );
    }
    return cwd;
  }

  function runCursor(cwd: string, extra: string[], env: NodeJS.ProcessEnv = process.env) {
    return spawnSync(
      node,
      [cursor, "--bin", agentEchoArgv, "--prompt", "do the task", "--deck-bin", deckFake, ...extra],
      { cwd, encoding: "utf8", env },
    );
  }

  function pluginDirs(cwd: string): string[] {
    const argv = JSON.parse(readFileSync(join(cwd, "argv.json"), "utf8")) as string[];
    return argv.flatMap((arg, at) => (argv[at - 1] === "--plugin-dir" ? [arg] : []));
  }

  it("loads local plugin folders first, then the base and the profile deck built", () => {
    const root = sandbox();
    const core = localPlugin(root, "builder");
    const cwd = project(root, { base: true, profile: "builder" });
    const out = join(root, "plugins");
    const result = runCursor(cwd, [
      "--plugin-dir",
      core,
      "--profile",
      "builder",
      "--plugins-out",
      out,
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(pluginDirs(cwd), [
      core,
      join(out, "builder", "git-workflow"),
      join(out, "builder", "builder-kit"),
    ]);
    const deckArgs = JSON.parse(readFileSync(join(cwd, "deck-args.json"), "utf8")) as string[];
    assert.deepEqual(deckArgs, [
      "materialize",
      "-C",
      realpathSync(cwd),
      "--out",
      join(out, "builder"),
      "--json",
      "--profile",
      "builder",
    ]);
    const payload = lastPayload(result.stdout);
    assert.deepEqual(payload.plugins, [
      { id: "core-builder", path: core, from: "local", integrity: null },
      {
        id: "git-workflow",
        path: join(out, "builder", "git-workflow"),
        from: "deck",
        integrity: "sha256-git-workflow",
      },
      {
        id: "builder-kit",
        path: join(out, "builder", "builder-kit"),
        from: "deck",
        integrity: "sha256-builder-kit",
      },
    ]);
  });

  it("adds the profile's prompt after the filled one, and only when it says something", () => {
    const root = sandbox();
    const cwd = project(root, { base: true, profile: "builder" });
    const out = join(root, "plugins");
    const empty = runCursor(cwd, ["--profile", "builder", "--plugins-out", out]);
    assert.equal(empty.status, 0, empty.stderr);
    let argv = JSON.parse(readFileSync(join(cwd, "argv.json"), "utf8")) as string[];
    assert.equal(argv.at(-1), "do the task");

    writeFileSync(
      join(cwd, ".ai", "profiles", "builder", "prompt.md"),
      "Use /impeccable polish.\n",
    );
    const said = runCursor(cwd, ["--profile", "builder", "--plugins-out", out]);
    assert.equal(said.status, 0, said.stderr);
    argv = JSON.parse(readFileSync(join(cwd, "argv.json"), "utf8")) as string[];
    assert.equal(
      argv.at(-1),
      "do the task\n\n## Project instructions for this role\n\nUse /impeccable polish.\n",
    );
  });

  it("falls back to the base when the project has no such profile", () => {
    const root = sandbox();
    const cwd = project(root, { base: true });
    const out = join(root, "plugins");
    const result = runCursor(cwd, ["--profile", "reviewer", "--plugins-out", out]);
    assert.equal(result.status, 0, result.stderr);
    const deckArgs = JSON.parse(readFileSync(join(cwd, "deck-args.json"), "utf8")) as string[];
    assert.equal(deckArgs.includes("--profile"), false);
    assert.deepEqual(pluginDirs(cwd), [join(out, "reviewer", "git-workflow")]);
    assert.match(result.stderr, /no deck profile reviewer: base plugins only/);
  });

  it("loads no project plugin when the project has no deck setup", () => {
    const root = sandbox();
    const cwd = project(root, { base: false });
    const result = runCursor(cwd, ["--profile", "builder", "--plugins-out", join(root, "plugins")]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(cwd, "deck-args.json")), false);
    assert.deepEqual(pluginDirs(cwd), []);
    assert.equal(lastPayload(result.stdout).plugins, undefined);
  });

  it("refuses before starting the vendor when deck refuses the profile", () => {
    const root = sandbox();
    const cwd = project(root, { base: true, profile: "builder" });
    const result = runCursor(
      cwd,
      ["--profile", "builder", "--plugins-out", join(root, "plugins")],
      {
        ...process.env,
        DECK_FAKE_MODE: "fail",
      },
    );
    assert.notEqual(result.status, 0);
    const payload = JSON.parse(result.stdout.trim()) as { error: string };
    assert.match(payload.error, /deck materialize refused profile builder: .*not pinned/);
    assert.match(payload.error, /commit its locks/);
    assert.equal(existsSync(join(cwd, "argv.json")), false);
  });

  it("refuses --profile without --plugins-out, and a name that is not a profile's", () => {
    const root = sandbox();
    const cwd = project(root, { base: true, profile: "builder" });
    const noOut = runCursor(cwd, ["--profile", "builder"]);
    assert.notEqual(noOut.status, 0);
    assert.match((JSON.parse(noOut.stdout.trim()) as { error: string }).error, /--plugins-out/);
    const traversal = runCursor(cwd, ["--profile", "../x", "--plugins-out", join(root, "plugins")]);
    assert.notEqual(traversal.status, 0);
    assert.match(
      (JSON.parse(traversal.stdout.trim()) as { error: string }).error,
      /not a deck profile/,
    );
    assert.equal(existsSync(join(cwd, "argv.json")), false);
  });

  it("refuses a --plugin-dir that is not a folder", () => {
    const root = sandbox();
    const cwd = project(root, { base: false });
    const result = runCursor(cwd, ["--plugin-dir", join(root, "missing")]);
    assert.notEqual(result.status, 0);
    assert.match((JSON.parse(result.stdout.trim()) as { error: string }).error, /is not a folder/);
  });

  it("gives Claude local plugin folders but refuses a deck profile", () => {
    const root = sandbox();
    const core = localPlugin(root, "planner");
    const cwd = project(root, { base: true, profile: "planner" });
    const ok = spawnSync(
      node,
      [claude, "--bin", agentEchoArgv, "--prompt", "hi", "--plugin-dir", core],
      { cwd, encoding: "utf8" },
    );
    assert.equal(ok.status, 0, ok.stderr);
    assert.deepEqual(pluginDirs(cwd), [core]);
    rmSync(join(cwd, "argv.json"));
    const refused = spawnSync(
      node,
      [
        claude,
        "--bin",
        agentEchoArgv,
        "--prompt",
        "hi",
        "--profile",
        "planner",
        "--plugins-out",
        join(root, "plugins"),
      ],
      { cwd, encoding: "utf8" },
    );
    assert.notEqual(refused.status, 0);
    assert.match(
      (JSON.parse(refused.stdout.trim()) as { error: string }).error,
      /does not isolate/,
    );
    assert.equal(existsSync(join(cwd, "argv.json")), false);
    assert.equal(existsSync(join(cwd, "deck-args.json")), false);
  });
});

describe("claude agent", () => {
  it("passes --verbose with stream-json", () => {
    const cwd = sandbox();
    const result = spawnSync(node, [claude, "--bin", agentEchoArgv, "--prompt", "hi"], {
      cwd,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const argv = JSON.parse(readFileSync(join(cwd, "argv.json"), "utf8")) as string[];
    assert.ok(argv.includes("--verbose"));
    const formatAt = argv.indexOf("--output-format");
    assert.equal(argv[formatAt + 1], "stream-json");
  });

  it("refuses --agent-home and does not start the vendor", () => {
    const cwd = sandbox();
    const result = spawnSync(
      node,
      [
        claude,
        "--bin",
        agentEchoArgv,
        "--prompt",
        "hi",
        "--agent-home",
        join(cwd, "agent-home"),
        "--api-key-env",
        "MASON_TEST_AGENT_KEY",
      ],
      {
        cwd,
        encoding: "utf8",
        env: parentEnv(sandbox(), { MASON_TEST_AGENT_KEY: "test-key-not-real" }),
      },
    );
    assert.notEqual(result.status, 0);
    const payload = JSON.parse(result.stdout.trim()) as { error: string };
    assert.match(payload.error, /does not isolate/);
    assert.equal(existsSync(join(cwd, "argv.json")), false);
  });

  it("omits --verbose when the format is not stream-json", () => {
    const cwd = sandbox();
    const result = spawnSync(
      node,
      [claude, "--bin", agentEchoArgv, "--output-format", "json", "--prompt", "hi"],
      { cwd, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const argv = JSON.parse(readFileSync(join(cwd, "argv.json"), "utf8")) as string[];
    assert.ok(!argv.includes("--verbose"));
  });
});
