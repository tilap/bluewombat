import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { stringify as stringifyYaml } from "yaml";
import { DEFAULT_CONFIG_FILENAME } from "../config/find-config.js";
import { PROMPT_PLACEHOLDERS, type RoleReport, runExplain } from "./explain.js";

const node = process.execPath;
const here = dirname(fileURLToPath(import.meta.url));
const builder = join(here, "../../fixtures/builder-write-marker.mjs");
const gate = join(here, "../../fixtures/gate-pass.mjs");

const PROMPT = "Task:\n{{task}}\n\n{{history}}\n\nRules:\n{{rules}}\n";

function write(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function lockOf(ids: string[], over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    lockfileVersion: 3,
    plugins: ids.map((id) => ({
      id,
      request: { id, source: `github:acme/${id}`, ref: "v1" },
      resolved: { type: "git", sha: "abcdef0123456789" },
      integrity: `sha256-${id}`,
      components: {
        skills: [`${id}-skill`],
        agents: [],
        commands: [],
        rules: [],
        hooks: id === "hooky",
        mcp: [],
      },
      ...over,
    })),
  });
}

type Options = {
  prompt?: string | null;
  stable?: "missing" | "plain";
  base?: string[];
  profile?: string[] | null;
  baseLock?: string | null;
  profilePrompt?: string;
  producer?: Record<string, unknown>;
  config?: Record<string, unknown>;
};

function sandbox(options: Options = {}): string {
  const root = mkdtempSync(join(tmpdir(), "host-explain-"));
  if (options.prompt !== null) {
    write(join(root, "roles/producer/prompt.md"), options.prompt ?? PROMPT);
  }
  const plugin = join(root, "roles/producer/plugin");
  write(join(plugin, ".claude-plugin/plugin.json"), JSON.stringify({ name: "producer-box" }));
  write(join(plugin, ".cursor-plugin/plugin.json"), JSON.stringify({ name: "producer-box" }));
  write(join(plugin, "skills/verify/SKILL.md"), "# verify\n");
  write(join(plugin, "agents/reviewer.md"), "# reviewer\n");
  const stable = join(root, "stable");
  if (options.stable !== "missing") {
    mkdirSync(stable, { recursive: true });
    const base = options.base ?? ["alpha"];
    write(join(stable, "ai-plugin.json"), JSON.stringify({ plugins: base.map((id) => ({ id })) }));
    if (options.baseLock !== null) {
      write(join(stable, "ai-plugin.lock.json"), options.baseLock ?? lockOf(base));
    }
    if (options.profile !== null) {
      const own = options.profile ?? ["hooky"];
      write(
        join(stable, ".ai/profiles/builder/ai-plugin.json"),
        JSON.stringify({ plugins: own.map((id) => ({ id })) }),
      );
      write(join(stable, ".ai/profiles/builder/ai-plugin.lock.json"), lockOf(own));
      write(
        join(stable, ".ai/profiles/builder/prompt.md"),
        options.profilePrompt ?? "Follow the hooky skill for visible changes.\n",
      );
    }
  }
  const fake = {
    package: "@bluewombat/manager-fake",
    options: { source: "./source", target: "./threads" },
  };
  mkdirSync(join(root, "source"), { recursive: true });
  write(
    join(root, DEFAULT_CONFIG_FILENAME),
    stringifyYaml({
      featureTracker: fake,
      ticketTracker: fake,
      workLine: { stable: "./stable", isolation: "@bluewombat/isolation-copy" },
      workspaceRoot: "./.mason/workspaces",
      ledger: "./.mason/ledger",
      agents: {
        cursor: {
          adapter: "cursor",
          home: "./.mason/agent-home",
          apiKeyEnv: "CURSOR_API_KEY",
          denyShell: ["gh"],
          transcripts: "./.mason/transcripts",
          pluginsOut: "./.mason/plugins",
        },
      },
      builder: {
        producer: {
          agent: "cursor",
          args: ["--model", "composer-2.5"],
          prompt: "./roles/producer/prompt.md",
          homePlugins: ["./roles/producer/plugin"],
          appDeckProfile: ".ai/profiles/builder",
          timeoutMs: 600_000,
          ...options.producer,
        },
        repair: { cmd: [node, builder], timeoutMs: 600_000 },
        gates: { gates: [{ id: "check", argv: [node, gate], timeoutMs: 10_000 }] },
      },
      timeoutMs: 1000,
      ...options.config,
    }),
  );
  return root;
}

async function explain(cwd: string, argv: string[] = [], env: Record<string, string> = {}) {
  const out: string[] = [];
  const code = await runExplain({ cwd, argv, env, write: (text) => out.push(text) });
  return { code, out: out.join("") };
}

async function reports(cwd: string, role = "builder.producer", env = {}) {
  const { code, out } = await explain(cwd, [role, "--json"], env);
  return { code, report: (JSON.parse(out) as { roles: RoleReport[] }).roles[0] as RoleReport };
}

describe("runExplain", () => {
  it("lays the prompt, the home's plugin and the project's deck side by side", async () => {
    const { code, out } = await explain(sandbox(), ["builder.producer"], { CURSOR_API_KEY: "k" });
    assert.equal(code, 0);
    assert.match(out, /agent {7}cursor, model composer-2\.5, 600s per attempt/);
    assert.match(out, /key from \$CURSOR_API_KEY \(set\); refuses: gh, ssh, scp/);
    assert.match(out, /prompt {6}\.\/roles\/producer\/prompt\.md {3}\[home\]/);
    assert.match(out, /fills: \{\{task\}\} \{\{history\}\} \{\{rules\}\}/);
    assert.match(out, /\[home\]\s+producer-box\s+\.\/roles\/producer\/plugin/);
    assert.match(out, /skills: verify/);
    assert.match(out, /agents: reviewer/);
    assert.match(out, /\[base\]\s+alpha\s+github:acme\/alpha @ v1 \(abcdef0\)/);
    assert.match(out, /skills: alpha-skill/);
    assert.match(out, /\[profile\] hooky/);
    assert.match(out, /hooks: yes, they run code/);
    assert.match(out, /then .*prompt\.md {3}\[project\]: "Follow the hooky skill/);
    assert.match(out, /Not shown here:/);
    assert.doesNotMatch(out, /FAIL|warn/);
  });

  it("never prints the key, only whether its variable is set", async () => {
    const { out } = await explain(sandbox(), ["builder.producer"], { CURSOR_API_KEY: "s3cret" });
    assert.doesNotMatch(out, /s3cret/);
    const unset = await explain(sandbox(), ["builder.producer"]);
    assert.match(unset.out, /\(not set in this shell\)/);
  });

  it("says a role that runs a command is not an agent, and shows nothing else", async () => {
    const { code, out } = await explain(sandbox(), ["builder.repair"]);
    assert.equal(code, 0);
    assert.match(out, /this role runs a command, not an agent/);
    assert.doesNotMatch(out.split("Not shown here")[0] ?? "", /plugins|prompt /);
  });

  it("does not guess the project's side before the work line exists", async () => {
    const { code, report } = await reports(sandbox({ stable: "missing" }));
    // `operators` work line with no directory: said as a failure, not skipped.
    assert.equal(code, 1);
    assert.equal(report.project?.state, "invalid");
    assert.deepEqual(
      report.plugins.map((plugin) => plugin.layer),
      ["home"],
    );
  });

  it("says the project's side is not known yet when the work line is copied on the first run", async () => {
    const github = { package: "@bluewombat/manager-github", options: { repo: "owner/repo" } };
    const root = sandbox({
      config: {
        featureTracker: github,
        ticketTracker: github,
        workLine: { isolation: "@bluewombat/isolation-git" },
        authority: { enabled: true, publish: [node, gate], refresh: [node, gate] },
        feature: {
          fix: { cmd: [node, builder], timeoutMs: 600_000 },
          validate: {
            cmd: [node, builder],
            timeoutMs: 600_000,
            gates: { gates: [{ id: "tests", argv: [node, gate], timeoutMs: 10_000 }] },
          },
          gates: { gates: [{ id: "check", argv: [node, gate], timeoutMs: 10_000 }] },
        },
        ticket: {
          validate: { agent: false },
          fix: { cmd: [node, builder], timeoutMs: 600_000 },
          gates: { gates: [{ id: "check", argv: [node, gate], timeoutMs: 10_000 }] },
        },
      },
    });
    const { code, out } = await explain(root, ["builder.producer"]);
    assert.equal(code, 0);
    assert.match(
      out,
      /project\s+not known yet: the work line .*work-line does not exist before the first run/,
    );
    assert.doesNotMatch(out, /\[base\]|\[profile\]/);
    assert.match(out, /\[home\]/);
  });

  it("says when the project has no deck, and when it has no such profile", async () => {
    const root = sandbox({ profile: null });
    const { report } = await reports(root);
    assert.deepEqual(
      report.plugins.map((plugin) => plugin.id),
      ["producer-box", "alpha"],
    );
    assert.ok(
      report.notes.some((note) => /no deck profile "\.ai\/profiles\/builder"/.test(note.text)),
    );
    assert.equal(
      report.notes.every((note) => note.level === "warn"),
      true,
    );
  });

  it("fails, and lists nothing from it, when a request is not pinned", async () => {
    const root = sandbox({ baseLock: null });
    const { code, report } = await reports(root);
    assert.equal(code, 1);
    assert.ok(
      report.notes.some(
        (note) => note.level === "fail" && /no committed ai-plugin\.lock\.json/.test(note.text),
      ),
    );
    assert.equal(
      report.plugins.some((plugin) => plugin.layer === "base"),
      false,
    );
    assert.equal(
      report.plugins.some((plugin) => plugin.layer === "profile"),
      true,
    );
  });

  it("does not read what a lock of another version brings", async () => {
    const root = sandbox({
      baseLock: lockOf(["alpha"]).replace('"lockfileVersion":3', '"lockfileVersion":9'),
    });
    const { report } = await reports(root);
    const alpha = report.plugins.find((plugin) => plugin.id === "alpha");
    assert.equal(alpha?.skills, undefined);
    assert.equal(alpha?.note, "contents not known");
    assert.ok(report.notes.some((note) => /lockfileVersion 9, not 3/.test(note.text)));
  });

  it("refuses a prompt the slot would refuse on every attempt", async () => {
    const noTask = await reports(sandbox({ prompt: "Do the thing.\n{{rules}}\n" }));
    assert.equal(noTask.code, 1);
    assert.ok(noTask.report.notes.some((note) => /does not place \{\{task\}\}/.test(note.text)));
    const typo = await reports(sandbox({ prompt: "{{task}} {{rules}} {{taks}}\n" }));
    assert.ok(
      typo.report.notes.some((note) =>
        /\{\{taks\}\}, which this role does not fill/.test(note.text),
      ),
    );
    const missing = await reports(sandbox({ prompt: null }));
    assert.ok(missing.report.notes.some((note) => /cannot be read/.test(note.text)));
  });

  it("warns when two plugins bring a skill of the same name", async () => {
    const root = sandbox({ base: ["verify"] });
    const { report } = await reports(root);
    assert.ok(
      report.notes.some(
        (note) => note.level === "warn" && /skill "verify" is in several plugins/.test(note.text),
      ) || report.plugins.filter((plugin) => plugin.skills?.includes("verify")).length === 1,
    );
  });

  it("refuses an unknown role by naming the roles", async () => {
    const { code, out } = await explain(sandbox(), ["builder.nope"]);
    assert.equal(code, 2);
    assert.match(out, /No role "builder\.nope".*Roles: builder\.producer, builder\.repair/);
  });

  it("writes JSON that carries the same facts and what it does not cover", async () => {
    const { out } = await explain(sandbox(), ["--json"]);
    const parsed = JSON.parse(out) as { roles: RoleReport[]; notCovered: string[] };
    assert.deepEqual(
      parsed.roles.map((role) => role.role),
      ["builder.producer", "builder.repair"],
    );
    assert.equal(parsed.notCovered.length, 2);
  });
});

describe("the placeholders each role fills", () => {
  it("are the ones the slots' own prompt fill, so this table cannot drift", () => {
    const slots = join(here, "../../../../plugins/slots");
    const files: Record<string, string> = {
      "builder.producer": "builders/producer.mjs",
      "builder.repair": "builders/repair.mjs",
      "ticket.fix": "ticket/fix.mjs",
      "ticket.validate": "ticket/validate.mjs",
      "feature.fix": "feature/fix.mjs",
      "authority.describe": "messages/git-producer.mjs",
    };
    for (const [role, file] of Object.entries(files)) {
      const source = readFileSync(join(slots, file), "utf8");
      const call = /fillPrompt\(\s*template\.value,\s*\{([\s\S]*?)\n\s*\},\s*\[([^\]]*)\]/.exec(
        source,
      );
      assert.ok(call, `${file} has a fillPrompt call`);
      const known = [...(call?.[1] ?? "").matchAll(/^\s*([a-z_]+)\s*[:,]/gm)].map(
        (match) => match[1],
      );
      const required = [...(call?.[2] ?? "").matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
      const table = PROMPT_PLACEHOLDERS[role];
      assert.deepEqual([...(table?.known ?? [])].sort(), [...known].sort(), `${role} known`);
      assert.deepEqual(
        [...(table?.required ?? [])].sort(),
        [...required].sort(),
        `${role} required`,
      );
    }
  });
});
