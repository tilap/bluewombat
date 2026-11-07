import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { openFilesystemPersist } from "@bluewombat/persist-fs";
import { openWorkLedger } from "@bluewombat/work-ledger";
import { DEFAULT_CONFIG_FILENAME } from "../../config/find-config.js";
import { fixtureYaml as stringifyYaml } from "../../config/fixture-yaml.js";
import { SUPERVISOR_FILENAME } from "./config.js";
import type { Exec } from "./exec.js";
import { runSupervise } from "./supervise.js";

const node = process.execPath;
const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "../../../fixtures");
const KEY = "fake:o/r#42";

function sandbox(supervisor: Record<string, unknown> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "host-supervise-"));
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
        producer: { cmd: [node, join(fixtures, "builder-write-marker.mjs")], timeoutMs: 30_000 },
        repair: { cmd: [node, join(fixtures, "builder-write-marker.mjs")], timeoutMs: 30_000 },
        gates: {
          gates: [
            {
              id: "check",
              argv: [node, join(fixtures, "gate-fail-blocking.mjs")],
              timeoutMs: 10_000,
            },
          ],
        },
      },
      timeoutMs: 30_000,
    }),
  );
  const agent = { cmd: ["agent", "{prompt}"], timeoutMs: 1000 };
  writeFileSync(
    join(root, SUPERVISOR_FILENAME),
    stringifyYaml({
      cooldownMs: 0,
      resume: { cmd: ["signal-resume", "{key}", "{number}"] },
      agents: {
        rootcause: agent,
        remedy: agent,
        skeptic: agent,
        arbiter: agent,
        fixer: agent,
        reviewer: agent,
      },
      ...supervisor,
    }),
  );
  return root;
}

async function escalate(cwd: string): Promise<void> {
  const ledger = openWorkLedger({
    persist: await openFilesystemPersist({ root: join(cwd, ".mason/ledger") }),
  });
  const intention = (key: string, extra: object = {}) => ({
    key,
    project: "proj",
    fingerprint: "f",
    priority: 50,
    intention: `deliver ${key}`,
    ...extra,
  });
  await ledger.admitFeature({
    ...intention("fake:o/r#1"),
    blocked_by: [],
    merge_when_ready: false,
  });
  await ledger.admit(intention(KEY, { feature: "fake:o/r#1" }));
  await ledger.openFeature({ key: "fake:o/r#1", tickets: [KEY] });
  await ledger.claim("proj");
  await ledger.startUnit(KEY);
  await ledger.recordAttempt({
    key: KEY,
    number: 1,
    trace: { ended: "fail-blocking", report: "gate blocked", refusedBy: "check" },
  });
  await ledger.escalate({ key: KEY, kind: "unit", report: "gate blocked", refusedBy: "check" });
}

const decisionFor = (extra: object = {}) =>
  `The cause is a gate that blocks.\n\`\`\`json\n${JSON.stringify({
    summary: "a gate blocked the unit",
    cause: "the check gate fails on a marker the builder never writes",
    evidence: ["gate-fail-blocking.mjs:1 exits 1 unconditionally"],
    confidence: "high",
    unblockAfterFixes: false,
    unblock: [{ do: "resume", key: KEY, reason: "the gate was fixed" }],
    fixes: [],
    ...extra,
  })}\n\`\`\``;

/** Agents answer by the role in their prompt; everything else is recorded. */
function fakeWorld(arbiter: string = decisionFor()) {
  const calls: string[][] = [];
  const exec: Exec = async (cmd) => {
    calls.push(cmd);
    if (cmd[0] === "agent") {
      const prompt = cmd[1] ?? "";
      if (prompt.includes("You are the guard")) {
        const verdict = { verdict: "approve", checked: ["a.ts:1 → fine"], findings: [] };
        return { code: 0, stdout: `\`\`\`json\n${JSON.stringify(verdict)}\n\`\`\``, stderr: "" };
      }
      return {
        code: 0,
        stdout: prompt.includes("# Your role: arbiter") ? arbiter : "analysis\n",
        stderr: "",
      };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { calls, exec };
}

async function supervise(cwd: string, exec: Exec, argv: string[] = ["--once"]) {
  const lines: string[] = [];
  const code = await runSupervise({
    cwd,
    argv,
    write: (text) => lines.push(text),
    exec,
    now: () => new Date("2026-11-05T12:00:00Z"),
    sleep: async () => {},
  });
  return { code, output: lines.join("") };
}

const resumes = (calls: string[][]) => calls.filter((c) => c[0] === "signal-resume");
const supervisorDir = (cwd: string) => join(cwd, ".mason/supervisor");

describe("mason supervise", () => {
  it("finds an escalation, has a council decide, and resumes", async () => {
    const cwd = sandbox();
    await escalate(cwd);
    const world = fakeWorld();
    const { code, output } = await supervise(cwd, world.exec);
    assert.equal(code, 0, output);
    assert.match(output, /escalated/);
    assert.match(output, /decision \(high\)/);
    assert.deepEqual(resumes(world.calls), [["signal-resume", KEY, "42"]]);
    // three members and an arbiter, each with the prompt filed
    assert.equal(world.calls.filter((c) => c[0] === "agent").length, 4);
    const memory = JSON.parse(readFileSync(join(supervisorDir(cwd), "memory.json"), "utf8"));
    assert.equal(memory.entries[`escalated:${KEY}`].attempts, 1);
  });

  it("gathers the dossier the council reads", async () => {
    const cwd = sandbox();
    await escalate(cwd);
    await supervise(cwd, fakeWorld().exec);
    const incidents = join(supervisorDir(cwd), "incidents");
    const [name] = (await import("node:fs")).readdirSync(incidents);
    assert.ok(existsSync(join(incidents, name ?? "", "incident.md")));
    assert.ok(existsSync(join(incidents, name ?? "", "arbiter.prompt.md")));
    assert.match(
      readFileSync(join(incidents, name ?? "", "rootcause.prompt.md"), "utf8"),
      /incident\.md/,
    );
  });

  it("does nothing in a dry run, and says what it would have done", async () => {
    const cwd = sandbox();
    await escalate(cwd);
    const world = fakeWorld();
    const { output } = await supervise(cwd, world.exec, ["--once", "--dry-run"]);
    assert.match(output, /dry run: would resume fake:o\/r#42/);
    assert.deepEqual(resumes(world.calls), []);
  });

  it("holds when the arbiter is not sure, and asks again with that on record", async () => {
    const cwd = sandbox();
    await escalate(cwd);
    const world = fakeWorld(decisionFor({ confidence: "low" }));
    const first = await supervise(cwd, world.exec);
    assert.match(first.output, /held: low confidence/);
    assert.deepEqual(resumes(world.calls), []);
    await supervise(cwd, world.exec);
    const secondBrief = world.calls
      .filter((c) => c[0] === "agent" && c[1]?.includes("# Your role: root cause"))
      .pop();
    assert.match(secondBrief?.[1] ?? "", /held \(low confidence\)/);
  });

  it("gives up after its attempts and writes a page for a person", async () => {
    const cwd = sandbox({ maxAttempts: 2 });
    await escalate(cwd);
    const world = fakeWorld(decisionFor({ confidence: "low" }));
    await supervise(cwd, world.exec);
    await supervise(cwd, world.exec);
    const third = await supervise(cwd, world.exec);
    assert.match(third.output, /needs a person/);
    const page = readFileSync(join(supervisorDir(cwd), "needs-human.md"), "utf8");
    assert.match(page, /escalated:fake:o\/r#42/);
    assert.match(page, /attempts are spent/);
    const agentsBefore = world.calls.filter((c) => c[0] === "agent").length;
    await supervise(cwd, world.exec);
    assert.equal(
      world.calls.filter((c) => c[0] === "agent").length,
      agentsBefore,
      "it stops asking",
    );
  });

  it("leaves the same escalation alone while its last answer takes effect", async () => {
    const cwd = sandbox({ cooldownMs: 600_000 });
    await escalate(cwd);
    const world = fakeWorld();
    await supervise(cwd, world.exec);
    await supervise(cwd, world.exec);
    assert.equal(resumes(world.calls).length, 1);
  });

  it("retries a council whose arbiter answered badly, then reports it", async () => {
    const cwd = sandbox();
    await escalate(cwd);
    const world = fakeWorld("I am not sure what to say.");
    const { output } = await supervise(cwd, world.exec);
    assert.match(output, /council failed/);
    assert.equal(world.calls.filter((c) => c[1]?.includes("# Your role: arbiter")).length, 2);
    assert.deepEqual(resumes(world.calls), []);
  });

  it("lands the fixes of a stop that needs a person, and does not resume", async () => {
    const cwd = sandbox({
      targets: {
        mason: {
          repo: "/repo",
          checks: [{ cmd: ["npm", "test"] }],
          after: [{ cmd: ["release"] }],
        },
      },
    });
    await escalate(cwd);
    const world = fakeWorld(
      decisionFor({
        unblock: [],
        needsHuman: "a commit on the line",
        fixes: [
          {
            target: "mason",
            title: "Fix it",
            instruction: "Change a to b everywhere.",
            conformity: "AGENTS.md: minimal diff; no decision touched",
          },
        ],
      }),
    );
    const { output } = await supervise(cwd, world.exec);
    assert.match(output, /needs a person/);
    assert.deepEqual(resumes(world.calls), []);
    assert.ok(world.calls.some((c) => c.join(" ").includes("worktree add")));
  });

  it("refuses to start without its configuration", async () => {
    const cwd = sandbox();
    const { code, output } = await supervise(cwd, fakeWorld().exec, [
      "--once",
      "--supervisor-config",
      "nope.yaml",
    ]);
    assert.equal(code, 2);
    assert.match(output, /nope\.yaml/);
  });

  it("refuses a second supervisor on the same ledger", async () => {
    const cwd = sandbox();
    mkdirSync(supervisorDir(cwd), { recursive: true });
    writeFileSync(join(supervisorDir(cwd), "lock"), `${process.ppid}\n`);
    const { code, output } = await supervise(cwd, fakeWorld().exec);
    assert.equal(code, 2);
    assert.match(output, /holds/);
  });
});
