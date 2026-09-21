import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const node = process.execPath;
const here = dirname(fileURLToPath(import.meta.url));
const producer = join(here, "../builders/producer.mjs");
const repair = join(here, "../builders/repair.mjs");
const assemblyFix = join(here, "../assembly/fix.mjs");
const cursor = join(here, "../agents/cursor.mjs");
const claude = join(here, "../agents/claude.mjs");
const fixtures = join(here, "../fixtures");
const agentOk = join(fixtures, "agent-ok.mjs");
const agentFail = join(fixtures, "agent-fail.mjs");
const agentRefused = join(fixtures, "agent-refused.mjs");
const agentUnauthorized = join(fixtures, "agent-unauthorized.mjs");
const agentEchoArgv = join(fixtures, "agent-echo-argv.mjs");
const agentOauthExpired = join(fixtures, "agent-oauth-expired.mjs");

function sandbox(): string {
  return mkdtempSync(join(tmpdir(), "host-builder-"));
}

function run(
  cwd: string,
  agentExtra: string[] = [],
  roleExtra: string[] = [],
  implExtra: string[] = [],
) {
  return runRole(producer, cursor, cwd, agentExtra, roleExtra, implExtra);
}

function runRole(
  role: string,
  agent: string,
  cwd: string,
  agentExtra: string[],
  roleExtra: string[] = [],
  implExtra: string[] = [],
) {
  return spawnSync(
    node,
    [
      role,
      ...roleExtra,
      "--",
      node,
      agent,
      ...agentExtra,
      "--id",
      "t",
      "--attempt",
      "1",
      "--intention",
      "Write delivered.txt",
      "--definition-of-done",
      "delivered.txt exists",
      ...implExtra,
    ],
    { cwd, encoding: "utf8" },
  );
}

function failureOf(stdout: string): { outcome: string; report: string } {
  const lines = stdout
    .trim()
    .split("\n")
    .filter((line) => line.length > 0);
  const last = lines.at(-1);
  assert.ok(last !== undefined, `stdout: ${stdout}`);
  return JSON.parse(last) as { outcome: string; report: string };
}

function echoedPrompt(cwd: string): string {
  return String((JSON.parse(readFileSync(join(cwd, "argv.json"), "utf8")) as string[]).at(-1));
}

describe("builder producer", () => {
  it("fail-blocking when there is no intention", () => {
    const cwd = sandbox();
    const result = spawnSync(
      node,
      [producer, "--", node, cursor, "--bin", agentOk, "--definition-of-done", "x"],
      { cwd, encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.equal(failureOf(result.stdout).outcome, "fail-blocking");
  });

  it("fail-blocking when no agent command follows --", () => {
    const cwd = sandbox();
    const result = spawnSync(
      node,
      [producer, "--id", "t", "--attempt", "1", "--intention", "x", "--definition-of-done", "y"],
      { cwd, encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(failureOf(result.stdout).report, /agent command after --/);
  });

  it("fail-blocking on an option the agent does not have", () => {
    const cwd = sandbox();
    const result = run(cwd, ["--bin", agentOk, "--worktree"]);
    assert.notEqual(result.status, 0);
    const failure = failureOf(result.stdout);
    assert.equal(failure.outcome, "fail-blocking");
    assert.match(failure.report, /--worktree/);
  });

  it("fail-blocking when the Cursor CLI is missing", () => {
    const cwd = sandbox();
    const result = run(cwd, ["--bin", "/nonexistent/cursor-agent"]);
    assert.notEqual(result.status, 0);
    const failure = failureOf(result.stdout);
    assert.equal(failure.outcome, "fail-blocking");
    assert.match(failure.report, /Could not start/);
  });

  it("exits 0 when the agent completes", () => {
    const cwd = sandbox();
    const result = run(cwd, ["--bin", agentOk]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(cwd, "delivered.txt"), "utf8"), "ok\n");
  });

  it("fail-retryable when the agent exits non-zero", () => {
    const cwd = sandbox();
    const result = run(cwd, ["--bin", agentFail]);
    assert.notEqual(result.status, 0);
    const failure = failureOf(result.stdout);
    assert.equal(failure.outcome, "fail-retryable");
    assert.match(failure.report, /agent failed/);
    assert.equal(existsSync(join(cwd, "delivered.txt")), false);
  });

  it("fail-retryable when the agent reports its own error on exit 0", () => {
    const cwd = sandbox();
    const result = run(cwd, ["--bin", agentRefused]);
    assert.notEqual(result.status, 0);
    const failure = failureOf(result.stdout);
    assert.equal(failure.outcome, "fail-retryable");
    assert.match(failure.report, /I cannot do this/);
  });

  it("fail-blocking when the CLI is not logged in", () => {
    const cwd = sandbox();
    const result = run(cwd, ["--bin", agentUnauthorized]);
    assert.notEqual(result.status, 0);
    const failure = failureOf(result.stdout);
    assert.equal(failure.outcome, "fail-blocking");
    assert.match(failure.report, /logged in/);
  });

  it("puts the Task and the slot bounds in the prompt", () => {
    const cwd = sandbox();
    const result = run(cwd, ["--bin", agentEchoArgv]);
    assert.equal(result.status, 0, result.stderr);
    const prompt = echoedPrompt(cwd);
    assert.match(prompt, /Write delivered\.txt/);
    assert.match(prompt, /delivered\.txt exists/);
    assert.match(prompt, /do not commit, branch, stash/);
  });

  it("fail-blocking when a report arrives — that is the repair command's job", () => {
    const cwd = sandbox();
    const result = run(cwd, ["--bin", agentOk], [], ["--report", "boom"]);
    assert.notEqual(result.status, 0);
    assert.match(failureOf(result.stdout).report, /repair command/);
  });

  it("forwards the model and extra agent arguments", () => {
    const cwd = sandbox();
    const result = run(cwd, [
      "--bin",
      agentEchoArgv,
      "--model",
      "some-model",
      "--agent-arg",
      "--resume",
      "--agent-arg",
      "chat-1",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const argv = JSON.parse(readFileSync(join(cwd, "argv.json"), "utf8"));
    assert.deepEqual(argv.slice(0, 2), ["-p", "--force"]);
    assert.ok(argv.includes("--output-format"));
    assert.deepEqual(argv.slice(-4, -1), ["some-model", "--resume", "chat-1"]);
  });

  it("fail-blocking on an output format it cannot read", () => {
    const cwd = sandbox();
    const result = run(cwd, ["--bin", agentOk, "--output-format", "yaml"]);
    assert.notEqual(result.status, 0);
    const failure = failureOf(result.stdout);
    assert.equal(failure.outcome, "fail-blocking");
    assert.match(failure.report, /json, text or stream-json/);
  });

  it("takes the prompt template from --prompt-file", () => {
    const cwd = sandbox();
    const template = join(cwd, "prompt.md");
    writeFileSync(template, "House rules apply.\n\n{{task}}\n\n{{done_when}}\n\n{{rules}}\n");
    const result = run(cwd, ["--bin", agentEchoArgv], ["--prompt-file", template]);
    assert.equal(result.status, 0, result.stderr);
    const prompt = echoedPrompt(cwd);
    assert.match(prompt, /^House rules apply\./);
    assert.match(prompt, /Write delivered\.txt/);
    assert.match(prompt, /delivered\.txt exists/);
    assert.doesNotMatch(prompt, /unattended/);
  });

  it("refuses a template that leaves the rules out, before any agent runs", () => {
    const cwd = sandbox();
    const template = join(cwd, "prompt.md");
    writeFileSync(template, "House rules apply.\n\n{{task}}\n");
    const result = run(cwd, ["--bin", agentEchoArgv], ["--prompt-file", template]);
    assert.notEqual(result.status, 0);
    const failure = failureOf(result.stdout);
    assert.equal(failure.outcome, "fail-blocking");
    assert.match(failure.report, /must place \{\{rules\}\}/);
    assert.match(failure.report, /prompt\.md/);
    assert.equal(existsSync(join(cwd, "argv.json")), false, "no agent ran");
  });

  it("keeps the shipped rules available to a template", () => {
    const cwd = sandbox();
    const template = join(cwd, "prompt.md");
    writeFileSync(template, "{{task}}\n\n{{rules}}\n");
    const result = run(cwd, ["--bin", agentEchoArgv], ["--prompt-file", template]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(echoedPrompt(cwd), /do not commit, branch, stash/);
  });

  it("fail-blocking on a template placeholder it does not know", () => {
    const cwd = sandbox();
    const template = join(cwd, "prompt.md");
    writeFileSync(template, "{{task}}\n{{report}}\n");
    const result = run(cwd, ["--bin", agentEchoArgv], ["--prompt-file", template]);
    assert.notEqual(result.status, 0);
    const failure = failureOf(result.stdout);
    assert.equal(failure.outcome, "fail-blocking");
    assert.match(failure.report, /\{\{report\}\}/);
    assert.match(failure.report, /Known: \{\{task\}\}/);
  });

  it("fail-blocking on a template that never places the task", () => {
    const cwd = sandbox();
    const template = join(cwd, "prompt.md");
    writeFileSync(template, "Do something nice.\n");
    const result = run(cwd, ["--bin", agentEchoArgv], ["--prompt-file", template]);
    assert.notEqual(result.status, 0);
    const failure = failureOf(result.stdout);
    assert.equal(failure.outcome, "fail-blocking");
    assert.match(failure.report, /\{\{task\}\}/);
  });

  it("fail-blocking when the template is missing", () => {
    const cwd = sandbox();
    const result = run(cwd, ["--bin", agentEchoArgv], ["--prompt-file", join(cwd, "nope.md")]);
    assert.notEqual(result.status, 0);
    const failure = failureOf(result.stdout);
    assert.equal(failure.outcome, "fail-blocking");
    assert.match(failure.report, /Cannot read the prompt template/);
  });
});

describe("builder repair", () => {
  it("fail-blocking without a report", () => {
    const cwd = sandbox();
    const result = runRole(repair, cursor, cwd, ["--bin", agentOk]);
    assert.notEqual(result.status, 0);
    assert.match(failureOf(result.stdout).report, /needs --report/);
  });

  it("uses a repair prompt, with the refusal first", () => {
    const cwd = sandbox();
    const result = runRole(
      repair,
      cursor,
      cwd,
      ["--bin", agentEchoArgv],
      [],
      ["--attempt", "2", "--report", "the file was empty", "--report-from", "npm-test"],
    );
    assert.equal(result.status, 0, result.stderr);
    const prompt = echoedPrompt(cwd);
    assert.match(prompt, /^You are a coding agent[\s\S]*It was refused/);
    assert.match(prompt, /Refused by: npm-test/);
    assert.match(prompt, /the file was empty/);
    assert.ok(
      prompt.indexOf("the file was empty") < prompt.indexOf("Write delivered.txt"),
      "the reason comes before the request it has to be resolved against",
    );
  });

  it("says the producer itself failed when no Gate refused", () => {
    const cwd = sandbox();
    const result = runRole(
      repair,
      cursor,
      cwd,
      ["--bin", agentEchoArgv],
      [],
      ["--attempt", "2", "--report", "it crashed"],
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(echoedPrompt(cwd), /Refused by: the producer of the last attempt/);
  });

  it("fail-blocking on a repair template that never places the report", () => {
    const cwd = sandbox();
    const template = join(cwd, "prompt.md");
    writeFileSync(template, "{{task}}\n");
    const result = runRole(
      repair,
      cursor,
      cwd,
      ["--bin", agentEchoArgv],
      ["--prompt-file", template],
      ["--report", "boom"],
    );
    assert.notEqual(result.status, 0);
    assert.match(failureOf(result.stdout).report, /\{\{report\}\}/);
  });
});

describe("assembly fix", () => {
  it("places the report and not a first-pass heading", () => {
    const cwd = sandbox();
    const result = runRole(
      assemblyFix,
      cursor,
      cwd,
      ["--bin", agentEchoArgv],
      [],
      ["--report", "ci red", "--report-from", "ci-green"],
    );
    assert.equal(result.status, 0, result.stderr);
    const prompt = echoedPrompt(cwd);
    assert.match(prompt, /assembled feature/);
    assert.match(prompt, /Fix what the refusal names/);
    assert.match(prompt, /Refused by: ci-green/);
    assert.match(prompt, /ci red/);
  });
});

describe("claude agent", () => {
  it("exits 0 when the agent completes", () => {
    const cwd = sandbox();
    const result = runRole(producer, claude, cwd, ["--bin", agentOk]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(cwd, "delivered.txt"), "utf8"), "ok\n");
  });

  it("fail-retryable when the agent exits non-zero", () => {
    const cwd = sandbox();
    const result = runRole(producer, claude, cwd, ["--bin", agentFail]);
    assert.notEqual(result.status, 0);
    const failure = failureOf(result.stdout);
    assert.equal(failure.outcome, "fail-retryable");
    assert.match(failure.report, /agent failed/);
  });

  it("fail-blocking on an option it does not have", () => {
    const cwd = sandbox();
    const result = runRole(producer, claude, cwd, ["--bin", agentOk, "--sandbox", "disabled"]);
    assert.notEqual(result.status, 0);
    const failure = failureOf(result.stdout);
    assert.equal(failure.outcome, "fail-blocking");
    assert.match(failure.report, /Claude Code does not take "--sandbox"/);
  });

  it("fail-blocking when the sign-in has expired", () => {
    const cwd = sandbox();
    const result = runRole(producer, claude, cwd, ["--bin", agentOauthExpired]);
    assert.notEqual(result.status, 0);
    const failure = failureOf(result.stdout);
    assert.equal(failure.outcome, "fail-blocking");
    assert.match(failure.report, /OAuth session expired/);
  });

  it("fail-blocking on a permission mode that is not one of Claude's", () => {
    const cwd = sandbox();
    const result = runRole(producer, claude, cwd, ["--bin", agentOk, "--permission-mode", "yolo"]);
    assert.notEqual(result.status, 0);
    const failure = failureOf(result.stdout);
    assert.equal(failure.outcome, "fail-blocking");
    assert.match(failure.report, /bypassPermissions/);
  });

  it("runs headless in the workspace, with the prompt last", () => {
    const cwd = sandbox();
    const result = runRole(producer, claude, cwd, [
      "--bin",
      agentEchoArgv,
      "--model",
      "opus",
      "--agent-arg",
      "--add-dir",
      "--agent-arg",
      "docs",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const argv = JSON.parse(readFileSync(join(cwd, "argv.json"), "utf8"));
    assert.deepEqual(argv.slice(0, 6), [
      "-p",
      "--permission-mode",
      "bypassPermissions",
      "--output-format",
      "stream-json",
      "--verbose",
    ]);
    assert.deepEqual(argv.slice(6, 10), ["--model", "opus", "--add-dir", "docs"]);
    assert.equal(argv.length, 11);
    assert.match(String(argv.at(-1)), /Write delivered\.txt/);
    assert.ok(!argv.includes("--workspace"), "no Cursor-only flag leaks into Claude's argv");
    assert.ok(!argv.includes("--sandbox"));
  });
});

describe("builder rules", () => {
  it("takes what {{rules}} says from --rules-file", () => {
    const cwd = sandbox();
    const template = join(cwd, "prompt.md");
    const rules = join(cwd, "rules.md");
    writeFileSync(template, "{{task}}\n\n{{rules}}\n");
    writeFileSync(rules, "- Write in French.\n- Never touch the database.\n");
    const result = run(
      cwd,
      ["--bin", agentEchoArgv],
      ["--prompt-file", template, "--rules-file", rules],
    );
    assert.equal(result.status, 0, result.stderr);
    const prompt = echoedPrompt(cwd);
    assert.match(prompt, /Never touch the database/);
    assert.doesNotMatch(prompt, /do not commit, branch, stash/);
  });

  it("fail-blocking when the rules file is not there", () => {
    const cwd = sandbox();
    const result = run(cwd, ["--bin", agentEchoArgv], ["--rules-file", join(cwd, "absent.md")]);
    assert.notEqual(result.status, 0);
    const failure = failureOf(result.stdout);
    assert.equal(failure.outcome, "fail-blocking");
    assert.match(failure.report, /rules file/);
  });
});

describe("builder transcript", () => {
  function transcripts(dir: string): string[] {
    const contexts = readdirSync(dir);
    return contexts.flatMap((context) =>
      readdirSync(join(dir, context)).map((name) => join(dir, context, name)),
    );
  }

  it("writes nothing unless a directory is asked for", () => {
    const cwd = sandbox();
    const result = run(cwd, ["--bin", agentEchoArgv]);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!existsSync(join(cwd, "transcripts")));
  });

  it("writes one file for the turn, filed under its context", () => {
    const cwd = sandbox();
    const dir = join(cwd, "transcripts");
    const result = spawnSync(
      node,
      [
        producer,
        "--",
        node,
        cursor,
        "--bin",
        agentEchoArgv,
        "--transcript-dir",
        dir,
        "--id",
        "s1",
        "--attempt",
        "2",
        "--context",
        "github:tilap/mason-one#34",
        "--intention",
        "Write delivered.txt",
        "--definition-of-done",
        "delivered.txt exists",
      ],
      { cwd, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const written = transcripts(dir);
    assert.equal(written.length, 1);
    assert.match(written[0] as string, /github-tilap-mason-one-34/);
    assert.match(written[0] as string, /s1-attempt-2-/);
    const page = readFileSync(written[0] as string, "utf8");
    assert.match(page, /# s1 · attempt 2/);
    assert.match(page, /- context: github:tilap\/mason-one#34/);
    assert.match(page, /## Prompt/);
    assert.match(page, /Write delivered\.txt/);
    assert.match(page, /## stdout/);
    assert.match(page, /## stderr/);
    assert.match(page, /- duration: /);
  });

  it("keeps only the parts that were asked for", () => {
    const cwd = sandbox();
    const dir = join(cwd, "transcripts");
    const result = run(cwd, [
      "--bin",
      agentEchoArgv,
      "--transcript-dir",
      dir,
      "--transcript-part",
      "timing",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const page = readFileSync(transcripts(dir)[0] as string, "utf8");
    assert.match(page, /- duration: /);
    assert.doesNotMatch(page, /## Prompt/);
    assert.doesNotMatch(page, /## stdout/);
    assert.doesNotMatch(page, /## stderr/);
  });

  it("refuses a part it does not have", () => {
    const cwd = sandbox();
    const result = run(cwd, [
      "--bin",
      agentEchoArgv,
      "--transcript-dir",
      join(cwd, "transcripts"),
      "--transcript-part",
      "everything",
    ]);
    assert.notEqual(result.status, 0);
    assert.equal(failureOf(result.stdout).outcome, "fail-blocking");
  });

  it("records a run the agent failed, not only a good one", () => {
    const cwd = sandbox();
    const dir = join(cwd, "transcripts");
    const result = run(cwd, ["--bin", agentFail, "--transcript-dir", dir]);
    assert.notEqual(result.status, 0);
    const page = readFileSync(transcripts(dir)[0] as string, "utf8");
    assert.match(page, /- exit: 1/);
  });
});
