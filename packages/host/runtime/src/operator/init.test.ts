import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { CONFIG_FILENAME } from "../config/find-config.js";
import { runInit } from "./init.js";

const here = dirname(fileURLToPath(import.meta.url));

function sandbox(): string {
  return mkdtempSync(join(tmpdir(), "host-init-"));
}

async function initIn(cwd: string, argv: string[] = []) {
  const lines: string[] = [];
  const result = await runInit({ cwd, argv, write: (line) => lines.push(line) });
  return { result, output: lines.join("") };
}

describe("runInit", () => {
  it("requires a manager package name", async () => {
    const { result } = await initIn(sandbox(), []);
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reason : "", /Missing --manager/);
  });

  it("writes a config from the manager's scaffold and a Builder stub", async () => {
    const cwd = sandbox();
    const { result, output } = await initIn(cwd, [
      "--manager",
      "@bluewombat/manager-github",
      "--manager-option",
      "repo=tilap/mason",
    ]);
    assert.equal(result.ok, true);

    const config = JSON.parse(readFileSync(join(cwd, CONFIG_FILENAME), "utf8"));
    assert.equal(config.manager, "@bluewombat/manager-github");
    assert.equal(config.managerOptions.repo, "tilap/mason");
    assert.deepEqual(config.managerOptions.labels, ["mason"]);
    assert.equal(existsSync(join(cwd, "mason-builder.mjs")), true);
    assert.equal(existsSync(join(cwd, "mason-gate.mjs")), false);
    assert.deepEqual(config.builder.gates.gates, []);
    // A producer with no ceiling is the failure this shape exists to prevent,
    // so `init` writes one rather than leaving a required key out.
    assert.equal(typeof config.builder.producer.timeoutMs, "number");
    assert.equal(typeof config.builder.repair.timeoutMs, "number");
    assert.equal(typeof config.builder.gates.defaultTimeoutMs, "number");
    // Where Host keeps its own files is a default, not a line to maintain.
    assert.equal(config.home, undefined);
    assert.equal(config.workspaceRoot, undefined);
    assert.equal(config.ledger, undefined);
    // GitHub names the reference work line, so Host keeps the copy: nothing
    // to point at, and the strategy that can fetch one.
    assert.equal(config.workLine.stable, undefined);
    assert.equal(config.workLine.isolation, "@bluewombat/isolation-git");
    assert.equal(config.workLineStable, undefined);
    assert.equal(existsSync(resolve(cwd, config.planner.cmd[1])), true);
    assert.match(output, /keeps a copy under \.mason\/work-line/);
    assert.match(output, /mason doctor/);
    assert.match(output, /GITHUB_TOKEN/);
  });

  it("asks for the work line only when the manager names no reference", async () => {
    const cwd = sandbox();
    const { result } = await initIn(cwd, ["--manager", "@bluewombat/manager-fake"]);
    assert.equal(result.ok, true);
    const config = JSON.parse(readFileSync(join(cwd, CONFIG_FILENAME), "utf8"));
    assert.equal(config.workLine.stable, "./work-line-stable");
    assert.equal(config.workLine.isolation, "@bluewombat/isolation-copy");
  });

  it("names the Project's own slots copy rather than a path on this machine", async () => {
    // A config is committed. Resolving the planner hands back the realpath of
    // whichever clone `npm link` points at, which belongs to nobody else.
    const cwd = sandbox();
    const planners = join(cwd, "node_modules", "@bluewombat", "slots", "planners");
    mkdirSync(planners, { recursive: true });
    writeFileSync(join(planners, "one-subtask.mjs"), "", "utf8");

    await initIn(cwd, ["--manager", "@bluewombat/manager-github"]);

    const config = JSON.parse(readFileSync(join(cwd, CONFIG_FILENAME), "utf8"));
    assert.equal(
      config.planner.cmd[1],
      "./node_modules/@bluewombat/slots/planners/one-subtask.mjs",
    );
    assert.equal(isAbsolute(config.planner.cmd[1]), false);
    assert.equal(existsSync(resolve(cwd, config.planner.cmd[1])), true);
  });

  it("does not invent a Gate for a project it does not know", async () => {
    const cwd = sandbox();
    await initIn(cwd, ["--manager", "@bluewombat/manager-fake"]);
    assert.equal(existsSync(join(cwd, "mason-gate.mjs")), false);
    const config = JSON.parse(readFileSync(join(cwd, CONFIG_FILENAME), "utf8"));
    assert.deepEqual(config.builder.gates.gates, []);
  });

  it("lets the fake manager prepare its Source and Thread directories", async () => {
    const cwd = sandbox();
    const { result } = await initIn(cwd, ["--manager", "@bluewombat/manager-fake"]);
    assert.equal(result.ok, true);
    const config = JSON.parse(readFileSync(join(cwd, CONFIG_FILENAME), "utf8"));
    assert.equal(config.managerOptions.source, "./.mason/source");
    assert.equal(existsSync(join(cwd, ".mason/source")), true);
    assert.equal(existsSync(join(cwd, ".mason/threads")), true);
  });

  it("does not overwrite an existing config without --force", async () => {
    const cwd = sandbox();
    const argv = ["--manager", "@bluewombat/manager-fake"];
    assert.equal((await initIn(cwd, argv)).result.ok, true);
    const second = await initIn(cwd, argv);
    assert.equal(second.result.ok, false);
    assert.match(second.result.ok === false ? second.result.reason : "", /--force/);
    assert.equal((await initIn(cwd, [...argv, "--force"])).result.ok, true);
  });

  it("still writes a config when the manager package is not installed yet", async () => {
    const { result, output } = await initIn(sandbox(), ["--manager", "@acme/manager-jira"]);
    assert.equal(result.ok, true);
    assert.match(output, /npm install @acme\/manager-jira/);
  });

  it("refuses a Host flag that names a tracker field", async () => {
    const { result } = await initIn(sandbox(), [
      "--manager",
      "@bluewombat/manager-github",
      "--repo",
      "a/b",
    ]);
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reason : "", /Unknown argument "--repo"/);
  });
});

describe("runInit with flags only", () => {
  it("runs a manager option through that question's own reader", async () => {
    const cwd = sandbox();
    installParsingManager(cwd);
    const { result } = await initIn(cwd, [
      "--manager",
      "@acme/manager-demo",
      "--manager-option",
      "board=app",
    ]);
    assert.equal(result.ok, true);
    const config = JSON.parse(readFileSync(join(cwd, CONFIG_FILENAME), "utf8"));
    // The question wraps it; the flag must land in the same shape as an answer.
    assert.deepEqual(config.managerOptions.board, ["app"]);
  });

  it("refuses a malformed manager option before writing anything", async () => {
    const cwd = sandbox();
    installParsingManager(cwd);
    const { result } = await initIn(cwd, [
      "--manager",
      "@acme/manager-demo",
      "--manager-option",
      "board=BAD",
    ]);
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reason : "", /--manager-option board: no/);
    assert.equal(existsSync(join(cwd, CONFIG_FILENAME)), false);
  });

  it("does not fail because the tracker still needs something", async () => {
    const cwd = sandbox();
    const { result } = await initIn(cwd, [
      "--manager",
      join(here, "../../fixtures/manager-blocked-setup.mjs"),
    ]);
    assert.equal(result.ok, true);
    // init wrote its files; a setup plan is a report, not this command's verdict.
    assert.equal(result.ok === true ? result.exitCode : -1, 0);
  });
});

function installParsingManager(cwd: string): void {
  const root = join(cwd, "node_modules/@acme/manager-demo");
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "@acme/manager-demo",
      type: "module",
      main: "index.mjs",
      keywords: ["mason-manager"],
    }),
  );
  writeFileSync(
    join(root, "index.mjs"),
    [
      "export function createManager() { return { ok: false, reason: 'stub' }; }",
      "export function questionsManager() {",
      "  return [{ key: 'board', prompt: 'Board', parse: (a) =>",
      "    a === 'BAD' ? { ok: false, reason: 'no' } : { ok: true, value: [a] } }];",
      "}",
    ].join("\n"),
  );
}

describe("runInit --clone", () => {
  function upstream(): string {
    const root = mkdtempSync(join(tmpdir(), "host-upstream-"));
    execFileSync("git", ["init", "-q", "-b", "main", root]);
    writeFileSync(join(root, "seed.txt"), "seed\n");
    execFileSync("git", ["-C", root, "add", "-A"]);
    execFileSync("git", [
      "-C",
      root,
      "-c",
      "user.email=a@b",
      "-c",
      "user.name=t",
      "commit",
      "-qm",
      "seed",
    ]);
    execFileSync("git", ["-C", root, "checkout", "-qb", "dev"]);
    execFileSync("git", [
      "-C",
      root,
      "-c",
      "user.email=a@b",
      "-c",
      "user.name=t",
      "commit",
      "-qm",
      "dev",
      "--allow-empty",
    ]);
    execFileSync("git", ["-C", root, "checkout", "-q", "main"]);
    return root;
  }

  function branchOf(path: string): string {
    return execFileSync("git", ["-C", path, "branch", "--show-current"], {
      encoding: "utf8",
    }).trim();
  }

  function cloneArgs(remote: string, extra: string[] = []): string[] {
    return [
      "--manager",
      "@bluewombat/manager-fake",
      "--work-line-stable",
      "./stable",
      "--clone",
      remote,
      ...extra,
    ];
  }

  it("clones the named branch", async () => {
    const cwd = sandbox();
    const { result } = await initIn(cwd, cloneArgs(upstream(), ["--branch", "dev"]));
    assert.equal(result.ok, true);
    assert.equal(branchOf(join(cwd, "stable")), "dev");
    const config = JSON.parse(readFileSync(join(cwd, CONFIG_FILENAME), "utf8"));
    assert.equal(config.workLine.isolation, "@bluewombat/isolation-git");
  });

  it("falls back to the remote's own default branch", async () => {
    const cwd = sandbox();
    const { result } = await initIn(cwd, cloneArgs(upstream()));
    assert.equal(result.ok, true);
    assert.equal(branchOf(join(cwd, "stable")), "main");
  });

  it("refuses a branch the remote does not carry, and lists the ones it has", async () => {
    const cwd = sandbox();
    const { result } = await initIn(cwd, cloneArgs(upstream(), ["--branch", "nope"]));
    assert.equal(result.ok, false);
    assert.match(
      result.ok === false ? result.reason : "",
      /has no branch "nope"\. It has: dev, main/,
    );
    assert.equal(existsSync(join(cwd, "stable")), false);
  });

  it("leaves an existing directory alone", async () => {
    const cwd = sandbox();
    const remote = upstream();
    await initIn(cwd, cloneArgs(remote, ["--branch", "dev"]));
    const { result, output } = await initIn(cwd, [
      ...cloneArgs(remote, ["--branch", "main"]),
      "--force",
    ]);
    assert.equal(result.ok, true);
    assert.equal(output.includes("Cloned"), false);
    // Still what the first clone put there.
    assert.equal(branchOf(join(cwd, "stable")), "dev");
  });
});

describe("runInit as a wizard", () => {
  function scripted(answers: string[]): {
    ask: (question: string) => Promise<string>;
    asked: string[];
  } {
    const asked: string[] = [];
    let index = 0;
    return {
      asked,
      ask: async (question: string) => {
        asked.push(question);
        return answers[index++] ?? "";
      },
    };
  }

  async function wizardIn(cwd: string, answers: string[], argv: string[] = []) {
    const lines: string[] = [];
    const scriptedAsk = scripted(answers);
    const result = await runInit({
      cwd,
      argv,
      env: {},
      write: (line) => lines.push(line),
      ask: scriptedAsk.ask,
    });
    return { result, output: lines.join(""), asked: scriptedAsk.asked };
  }

  it("picks the only installed manager, asks its questions, and writes them", async () => {
    const cwd = sandbox();
    mkdirSync(join(cwd, "node_modules/@acme/manager-demo"), { recursive: true });
    writeFileSync(
      join(cwd, "node_modules/@acme/manager-demo/package.json"),
      JSON.stringify({
        name: "@acme/manager-demo",
        type: "module",
        main: "index.mjs",
        keywords: ["mason-manager"],
      }),
    );
    writeFileSync(
      join(cwd, "node_modules/@acme/manager-demo/index.mjs"),
      [
        "export function createManager() { return { ok: false, reason: 'stub' }; }",
        "export function questionsManager() {",
        "  return [{ key: 'board', prompt: 'Board', required: true,",
        "    parse: (a) => a === 'bad' ? { ok: false, reason: 'not a board' } : { ok: true, value: a } }];",
        "}",
      ].join("\n"),
    );

    mkdirSync(join(cwd, "stable"), { recursive: true });
    const { result, output, asked } = await wizardIn(cwd, ["", "bad", "APP", "./stable"]);
    assert.equal(result.ok, true);
    assert.match(output, /Manager: @acme\/manager-demo/);
    // The refused answer is asked again rather than accepted.
    assert.equal(asked.filter((question) => question.startsWith("Board")).length, 2);
    assert.match(output, /not a board/);

    const config = JSON.parse(readFileSync(join(cwd, CONFIG_FILENAME), "utf8"));
    assert.equal(config.manager, "@acme/manager-demo");
    assert.equal(config.managerOptions.board, "APP");
    assert.equal(config.workLine.stable, "./stable");
  });

  it("skips the clone on an empty remote instead of failing", async () => {
    const cwd = sandbox();
    installStubManager(cwd);
    const { result, output } = await wizardIn(cwd, ["", "", "./stable", "", ""]);
    assert.equal(result.ok, true);
    assert.match(output, /Skipped\. Create .*stable before running mason/);
  });

  it("asks a question even when the scaffold already carries a placeholder", async () => {
    const cwd = sandbox();
    const root = join(cwd, "node_modules/@acme/manager-demo");
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "@acme/manager-demo",
        type: "module",
        main: "index.mjs",
        keywords: ["mason-manager"],
      }),
    );
    writeFileSync(
      join(root, "index.mjs"),
      [
        "export function createManager() { return { ok: false, reason: 'stub' }; }",
        "export function questionsManager() { return [{ key: 'board', prompt: 'Board' }]; }",
        "export function scaffoldManager(context) {",
        "  const board = context.options.board ?? 'PLACEHOLDER';",
        "  return { options: { board }, nextSteps: board === 'PLACEHOLDER' ? ['set board'] : [] };",
        "}",
      ].join("\n"),
    );
    mkdirSync(join(cwd, "stable"), { recursive: true });

    const { result, output, asked } = await wizardIn(cwd, ["", "APP", "./stable"]);
    assert.equal(result.ok, true);
    assert.equal(
      asked.some((question) => question.startsWith("Board")),
      true,
    );
    const config = JSON.parse(readFileSync(join(cwd, CONFIG_FILENAME), "utf8"));
    assert.equal(config.managerOptions.board, "APP");
    // The scaffold is asked again with the answer, so it stops demanding it.
    assert.equal(output.includes("set board"), false);
  });

  it("names the only installed manager and lets it be declined", async () => {
    const cwd = sandbox();
    installStubManager(cwd);
    mkdirSync(join(cwd, "stable"), { recursive: true });

    const { output, asked } = await wizardIn(cwd, ["", "", "./stable"]);
    assert.match(output, /Manager: @acme\/manager-demo/);
    // The prompt itself goes to the reader, not to the writer.
    assert.ok(asked.some((question) => question.startsWith("Use it? [Y/n]")));

    const declined = await wizardIn(cwd, ["n", "@acme/manager-elsewhere"], ["--force"]);
    assert.equal(declined.result.ok, false);
    assert.match(
      declined.result.ok === false ? declined.result.reason : "",
      /@acme\/manager-elsewhere is not installed here/,
    );
  });

  it("refuses when no manager package is installed, and says how to get one", async () => {
    const { result } = await wizardIn(sandbox(), []);
    assert.equal(result.ok, false);
    assert.match(
      result.ok === false ? result.reason : "",
      /No FeatureManager package is installed here[\s\S]*npm install @bluewombat\/manager-github/,
    );
  });

  it("reports the branch of an existing git WorkLineStable", async () => {
    const cwd = sandbox();
    installStubManager(cwd);
    const stable = join(cwd, "stable");
    mkdirSync(stable, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "dev", stable]);
    const { output } = await wizardIn(cwd, ["", "", "./stable"]);
    assert.match(output, /stable — git, on branch dev/);
  });

  it("does not ask again for an option already given on the command line", async () => {
    const cwd = sandbox();
    installStubManager(cwd, "board");
    mkdirSync(join(cwd, "stable"), { recursive: true });
    const { asked } = await wizardIn(cwd, ["", "./stable"], ["--manager-option", "board=APP"]);
    assert.equal(
      asked.some((question) => question.startsWith("Board")),
      false,
    );
  });
});

function installStubManager(cwd: string, key = "board"): void {
  const root = join(cwd, "node_modules/@acme/manager-demo");
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "@acme/manager-demo",
      type: "module",
      main: "index.mjs",
      keywords: ["mason-manager"],
    }),
  );
  writeFileSync(
    join(root, "index.mjs"),
    [
      "export function createManager() { return { ok: false, reason: 'stub' }; }",
      `export function questionsManager() { return [{ key: '${key}', prompt: 'Board' }]; }`,
    ].join("\n"),
  );
}
