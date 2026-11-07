import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { CLI_NAME } from "@bluewombat/manager-kit";
import { openWorkLedger, type WorkLedger } from "@bluewombat/work-ledger";
import { DEFAULT_CONFIG_FILENAME } from "../../config/find-config.js";
import { parseArgs } from "../../config/parse-args.js";
import type { HostInvocation } from "../../config/types.js";
import { journalPath } from "../../loop/journal.js";
import { acquireLock, liveLockHolder } from "../../loop/lock.js";
import { ownGroup } from "../../loop/process-tree.js";
import { openPersist } from "../../plugins/persist.js";
import { runCancel } from "../cancel.js";
import { runIncident } from "../incident.js";
import { runRestart } from "../restart.js";
import { type ActContext, carryOut, type Hands, type Outcome } from "./act.js";
import {
  findSupervisorConfig,
  loadSupervisorConfig,
  SUPERVISOR_FILENAME,
  type SupervisorConfig,
} from "./config.js";
import { deliberate } from "./council.js";
import { type Exec, fill, exec as realExec } from "./exec.js";
import {
  attempt,
  due,
  forgetKeys,
  loadMemory,
  type Memory,
  note,
  remember,
  saveMemory,
  spent,
} from "./memory.js";
import { type Finding, finished, type Item, observe, type Snapshot } from "./observe.js";

export type SuperviseInput = {
  cwd: string;
  argv: string[];
  write: (text: string) => void;
  interruptFlag?: { interrupted: boolean };
  exec?: Exec;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
};

type Flags = {
  once: boolean;
  dryRun: boolean;
  configFile?: string;
  rest: string[];
  error?: string;
};

/**
 * Watch a mason run, and do what a person would do by hand when it stops.
 *
 * It is another process than `run`, on the same ledger. It reads (the ledger,
 * the journal, the lock, the disk), decides what is wrong, has a council of
 * agents find the cause, and carries out the arbiter's decision: the move
 * that puts the run back in motion, and the changes to the repositories it
 * was given so that the stop does not come back. Those changes are offered as
 * pull requests and folded by the repository's own rules, so they can be undone.
 *
 * With `--dry-run` it deliberates and writes what it would do, and does none of it.
 */
export async function runSupervise(input: SuperviseInput): Promise<number> {
  const flags = peel(input.argv);
  if (flags.error !== undefined) {
    input.write(`${flags.error}\n`);
    return 2;
  }
  const parsed = parseArgs(flags.rest, { cwd: input.cwd, checkPaths: false });
  if (!parsed.ok) {
    input.write(`${parsed.reason}\n`);
    return 2;
  }
  const invocation = parsed.invocation;
  const path =
    flags.configFile === undefined
      ? findSupervisorConfig(invocation.configDir)
      : resolve(input.cwd, flags.configFile);
  if (path === undefined) {
    input.write(
      `No ${SUPERVISOR_FILENAME} found from ${invocation.configDir}. See \`${CLI_NAME} supervise --help\`.\n`,
    );
    return 2;
  }
  const loaded = loadSupervisorConfig(path, invocation.home);
  if (!loaded.ok) {
    input.write(`${loaded.reason}\n`);
    return 2;
  }
  const config = loaded.config;
  let release: () => Promise<void>;
  try {
    release = await acquireLock(config.dir);
  } catch (error) {
    input.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const now = input.now ?? (() => new Date());
  const say = (line: string): void => {
    input.write(`${now().toISOString()}  ${line}\n`);
    note(config.dir, { say: line }, now);
  };
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  try {
    say(
      `supervising ${invocation.ledgerRoot}${flags.dryRun ? " (dry run: nothing will be done)" : ""}`,
    );
    for (const target of config.targets.filter((t) => t.after.length === 0)) {
      say(
        `warning: target ${target.name} has no "after": a fix that is folded will not reach the running worker`,
      );
    }
    for (;;) {
      if (input.interruptFlag?.interrupted === true) {
        say("interrupted");
        return 0;
      }
      try {
        await pass({
          config,
          invocation,
          rest: flags.rest,
          dryRun: flags.dryRun,
          exec: input.exec ?? realExec,
          now,
          sleep,
          say,
          cwd: input.cwd,
          ...(input.interruptFlag === undefined ? {} : { interruptFlag: input.interruptFlag }),
        });
      } catch (error) {
        // A pass that fails is one pass lost, not a supervisor lost.
        say(`pass failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (flags.once) {
        return 0;
      }
      await sleep(config.pollIntervalMs);
    }
  } finally {
    await release();
  }
}

type PassInput = {
  config: SupervisorConfig;
  invocation: HostInvocation;
  rest: string[];
  dryRun: boolean;
  exec: Exec;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  say: (line: string) => void;
  cwd: string;
  interruptFlag?: { interrupted: boolean };
};

async function pass(p: PassInput): Promise<void> {
  const { config, invocation } = p;
  const opened = await openPersist(invocation.persist, invocation.configDir, invocation.ledgerRoot);
  if (!opened.ok) {
    throw new Error(opened.reason);
  }
  const ledger = openWorkLedger({ persist: opened.persist });
  const snapshot = await snapshotOf(ledger, invocation, config, p.now().getTime());
  const memory = loadMemory(config.dir);
  const findings = observe(snapshot, config);

  forgetKeys(memory, finished(snapshot.items));
  const present = new Set(findings.map((f) => f.subject));
  for (const subject of Object.keys(memory.entries)) {
    // `escalated:*` is kept until its key ends: a ticket that is resumed and stops again is one problem, not two.
    if (!subject.startsWith("escalated:") && !present.has(subject)) {
      delete memory.entries[subject];
    }
  }
  saveMemory(config.dir, memory);

  for (const finding of findings) {
    if (p.interruptFlag?.interrupted === true) {
      return;
    }
    const entry = memory.entries[finding.subject];
    if (!due(entry, finding.fingerprint, p.now().getTime(), config.cooldownMs)) {
      continue;
    }
    if (spent(entry, config.maxAttempts)) {
      await toPerson(p, memory, finding, "attempts are spent");
      continue;
    }
    await handle(p, memory, finding);
    saveMemory(config.dir, memory);
  }
}

async function handle(p: PassInput, memory: Memory, finding: Finding): Promise<void> {
  const { config, say } = p;
  const at = p.now().getTime();
  const entry = attempt(memory, finding.subject, finding.fingerprint, at);
  say(`${finding.kind}: ${finding.detail} (attempt ${entry.attempts}/${config.maxAttempts})`);
  const hands = handsOf(p);

  if (finding.kind === "worker-down") {
    const outcome = await hands.startWorker();
    remember(entry, `start worker: ${outcome.ok ? "ok" : outcome.detail}`);
    say(`worker: ${outcome.ok ? "started" : outcome.detail}`);
    return;
  }
  if (finding.kind === "disk-low") {
    const outcome = await carryOutPlain(p, hands, "cleanup-disk");
    remember(entry, `cleanup: ${outcome.ok ? "ok" : outcome.detail}`);
    say(`disk: ${outcome.ok ? "cleaned" : outcome.detail}`);
    if (!outcome.ok) {
      await toPerson(p, memory, finding, `disk cleanup failed: ${outcome.detail}`);
    }
    return;
  }

  const key = finding.key ?? "";
  const dir = join(config.dir, "incidents", `${stamp(p.now())}-${slug(key)}`);
  mkdirSync(dir, { recursive: true });
  const dossier = await gather(p, key, dir);
  const brief = {
    finding,
    ...(dossier ? { dossierDir: dir } : {}),
    ledgerRoot: p.invocation.ledgerRoot,
    configPath: join(p.invocation.configDir, DEFAULT_CONFIG_FILENAME),
    codeRoots: [
      ...config.targets.map((target) => target.repo),
      join(p.invocation.configDir, "node_modules", "@bluewombat"),
    ],
    targets: config.targets.map((target) => target.name),
    rules: config.targets.flatMap((target) =>
      target.rules.map((file) => join(target.repo, file)).filter((file) => existsSync(file)),
    ),
    history: entry.history,
  };
  say(`council on ${key}: ${dir}`);
  const result = await deliberate({
    config,
    exec: p.exec,
    brief,
    dir,
    cwd: p.invocation.configDir,
  });
  if (!result.ok) {
    remember(entry, `council failed: ${result.reason.slice(0, 300)}`);
    say(`council failed: ${result.reason}`);
    return;
  }
  const decision = result.decision;
  writeFileSync(join(dir, "decision.json"), `${JSON.stringify(decision, null, 2)}\n`);
  note(config.dir, { decision: decision.summary, key, confidence: decision.confidence, dir });
  say(`decision (${decision.confidence}): ${decision.summary}`);

  if (decision.needsHuman !== undefined) {
    remember(entry, `needs a person: ${decision.needsHuman.slice(0, 300)}`);
    // The run waits for a person, but what made it stop is still worth fixing now.
    if (decision.confidence !== "low" && decision.fixes.length > 0) {
      if (p.dryRun) {
        say(`dry run: would ${describe({ unblock: [], fixes: decision.fixes })}`);
      } else {
        const outcomes = await carryOut(
          { ...decision, unblock: [], unblockAfterFixes: false },
          { config, exec: p.exec, hands, dir, now: p.now, sleep: p.sleep, log: p.say },
        );
        writeFileSync(join(dir, "outcomes.json"), `${JSON.stringify(outcomes, null, 2)}\n`);
        for (const outcome of outcomes) {
          say(
            `${outcome.ok ? "done" : "FAILED"}  ${outcome.what}: ${outcome.detail.split("\n")[0]}`,
          );
          remember(entry, `${outcome.what}: ${outcome.ok ? "ok" : outcome.detail.slice(0, 300)}`);
        }
      }
    }
    await toPerson(p, memory, finding, decision.needsHuman, decision.summary);
    return;
  }
  if (decision.confidence === "low") {
    remember(entry, `held (low confidence): ${decision.cause.slice(0, 300)}`);
    say("held: low confidence, asking again with this on record");
    return;
  }
  if (p.dryRun) {
    remember(entry, `dry run: would ${describe(decision)}`);
    say(`dry run: would ${describe(decision)}`);
    return;
  }
  const context: ActContext = {
    config,
    exec: p.exec,
    hands,
    dir,
    now: p.now,
    sleep: p.sleep,
    log: p.say,
  };
  const outcomes = await carryOut(decision, context);
  writeFileSync(join(dir, "outcomes.json"), `${JSON.stringify(outcomes, null, 2)}\n`);
  for (const outcome of outcomes) {
    say(`${outcome.ok ? "done" : "FAILED"}  ${outcome.what}: ${outcome.detail.split("\n")[0]}`);
    remember(
      entry,
      `${decision.summary.slice(0, 120)} → ${outcome.what}: ${outcome.ok ? "ok" : outcome.detail.slice(0, 300)}`,
    );
  }
}

function describe(decision: {
  unblock: { do: string; key?: string }[];
  fixes: { target: string; title: string }[];
}): string {
  const moves = decision.unblock.map((u) => `${u.do}${u.key === undefined ? "" : ` ${u.key}`}`);
  const fixes = decision.fixes.map((f) => `fix ${f.target}: ${f.title}`);
  return [...moves, ...fixes].join("; ") || "nothing";
}

async function carryOutPlain(p: PassInput, hands: Hands, kind: "cleanup-disk"): Promise<Outcome> {
  const outcomes = await carryOut(
    {
      summary: kind,
      cause: kind,
      evidence: ["observed"],
      confidence: "high",
      unblockAfterFixes: false,
      unblock: [{ do: kind, reason: "observed" }],
      fixes: [],
    },
    { config: p.config, exec: p.exec, hands, dir: p.config.dir },
  );
  return outcomes[0] ?? { what: kind, ok: false, detail: "nothing ran" };
}

/** Hand it to a person: a page that says what is known, and a tap on the shoulder if one is configured. */
async function toPerson(
  p: PassInput,
  memory: Memory,
  finding: Finding,
  why: string,
  summary?: string,
): Promise<void> {
  const entry = memory.entries[finding.subject];
  if (entry === undefined) {
    return;
  }
  entry.human = true;
  const file = join(p.config.dir, "needs-human.md");
  mkdirSync(p.config.dir, { recursive: true });
  appendFileSync(
    file,
    `\n## ${p.now().toISOString()}  ${finding.subject}\n\n${summary ?? finding.detail}\n\nWhy a person: ${why}\n\nTried:\n${entry.history.map((line) => `- ${line}`).join("\n") || "- nothing"}\n`,
  );
  p.say(`needs a person: ${finding.subject} — ${why} (${file})`);
  const notify = p.config.notify;
  if (notify !== undefined) {
    await p.exec(fill(notify.cmd, { subject: finding.subject, file }), {
      timeoutMs: notify.timeoutMs,
    });
  }
  saveMemory(p.config.dir, memory);
}

async function gather(p: PassInput, key: string, dir: string): Promise<boolean> {
  const lines: string[] = [];
  const code = await runIncident({
    cwd: p.cwd,
    argv: [key, "--out", dir, "--with-config", ...p.rest],
    write: (text) => lines.push(text),
    now: p.now,
  });
  if (code !== 0) {
    p.say(`no dossier for ${key}: ${lines.join("").trim().split("\n")[0]}`);
  }
  return code === 0;
}

async function snapshotOf(
  ledger: WorkLedger,
  invocation: HostInvocation,
  config: SupervisorConfig,
  now: number,
): Promise<Snapshot> {
  const items: Item[] = [];
  for (const summary of await ledger.listFeatures()) {
    const item: Item = { key: summary.key, scope: "feature", state: summary.state };
    if (summary.state === "escalated") {
      const got = await ledger.getFeature(summary.key);
      const escalation = got.ok ? got.aggregate.escalation : undefined;
      if (escalation !== undefined) {
        item.escalation = pick(escalation);
      }
    }
    items.push(item);
  }
  for (const summary of await ledger.list()) {
    const item: Item = { key: summary.key, scope: "ticket", state: summary.state };
    if (summary.state === "escalated") {
      const got = await ledger.get(summary.key);
      const escalation = got.ok ? got.aggregate.escalation : undefined;
      if (escalation !== undefined) {
        item.escalation = pick(escalation);
      }
    }
    items.push(item);
  }
  const workerPid = await liveLockHolder(invocation.ledgerRoot);
  return {
    now,
    items,
    ...(workerPid === undefined ? {} : { workerPid }),
    ...journalAt(invocation.ledgerRoot),
    ...freeBytes(invocation.home),
    canStartWorker: config.worker.start !== undefined,
  };
}

function pick(escalation: {
  report?: string;
  refused_by?: string;
  at?: number;
}): NonNullable<Item["escalation"]> {
  return {
    ...(escalation.report === undefined ? {} : { report: escalation.report }),
    ...(escalation.refused_by === undefined ? {} : { refusedBy: escalation.refused_by }),
    ...(escalation.at === undefined ? {} : { at: escalation.at }),
  };
}

function journalAt(ledgerRoot: string): { journalAt?: number } {
  try {
    return { journalAt: statSync(journalPath(ledgerRoot)).mtimeMs };
  } catch {
    return {};
  }
}

function freeBytes(dir: string): { freeBytes?: number } {
  try {
    const stats = statfsSync(dir);
    return { freeBytes: stats.bavail * stats.bsize };
  } catch {
    return {};
  }
}

/** What only this process can do: stop and start the worker, and touch a ledger the worker holds. */
function handsOf(p: PassInput): Hands {
  const { config, invocation } = p;
  const startWorker = async (): Promise<Outcome> => {
    const start = config.worker.start;
    if (start === undefined) {
      return {
        what: "start-worker",
        ok: false,
        detail: "no `worker.start` in the supervisor config",
      };
    }
    if ((await liveLockHolder(invocation.ledgerRoot)) !== undefined) {
      return { what: "start-worker", ok: true, detail: "already running" };
    }
    mkdirSync(config.dir, { recursive: true });
    const log = openSync(join(config.dir, "worker.log"), "a");
    const [command, ...args] = start.cmd;
    // The worker outlives this process: it is not tracked, and is started in a group of its own.
    const child = spawn(command ?? "", args, {
      cwd: invocation.configDir,
      stdio: ["ignore", log, log],
      ...ownGroup(),
    });
    child.on("error", () => {});
    child.unref();
    for (let waited = 0; waited < start.timeoutMs; waited += 1000) {
      await p.sleep(1000);
      if ((await liveLockHolder(invocation.ledgerRoot)) !== undefined) {
        return { what: "start-worker", ok: true, detail: `pid ${child.pid}` };
      }
    }
    return {
      what: "start-worker",
      ok: false,
      detail: `no process holds the ledger after ${start.timeoutMs} ms (see worker.log)`,
    };
  };
  const stopWorker = async (): Promise<Outcome> => {
    const pid = await liveLockHolder(invocation.ledgerRoot);
    if (pid === undefined) {
      return { what: "stop-worker", ok: true, detail: "not running" };
    }
    // Pause: the unit in flight may finish, nothing new starts.
    process.kill(pid, "SIGTERM");
    for (let waited = 0; waited < 5 * 60_000; waited += 1000) {
      await p.sleep(1000);
      if ((await liveLockHolder(invocation.ledgerRoot)) === undefined) {
        return { what: "stop-worker", ok: true, detail: `pid ${pid} ended` };
      }
    }
    return {
      what: "stop-worker",
      ok: false,
      detail: `pid ${pid} still holds the ledger after 5 min`,
    };
  };
  /** The ledger lock is the worker's: take the ledger only while it is stopped, then give it back. */
  const withLedger = async (
    what: string,
    fn: () => Promise<number>,
    out: string[],
  ): Promise<Outcome> => {
    const stopped = await stopWorker();
    if (!stopped.ok) {
      return { what, ok: false, detail: stopped.detail };
    }
    let code: number;
    try {
      code = await fn();
    } finally {
      const started = await startWorker();
      if (!started.ok) {
        out.push(`worker not restarted: ${started.detail}`);
      }
    }
    return {
      what,
      ok: code === 0,
      detail: out.join("").trim() || (code === 0 ? "done" : `exit ${code}`),
    };
  };
  return {
    startWorker,
    async restartWorker() {
      const stopped = await stopWorker();
      return stopped.ok ? await startWorker() : stopped;
    },
    async restart(key) {
      const out: string[] = [];
      return await withLedger(
        `restart ${key}`,
        () => runRestart({ cwd: p.cwd, argv: [key, ...p.rest], write: (t) => out.push(t) }),
        out,
      );
    },
    async cancel(key) {
      const out: string[] = [];
      return await withLedger(
        `cancel ${key}`,
        () => runCancel({ cwd: p.cwd, argv: [key, ...p.rest], write: (t) => out.push(t) }),
        out,
      );
    },
  };
}

function peel(argv: string[]): Flags {
  const rest: string[] = [];
  let once = false;
  let dryRun = false;
  let configFile: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--once") {
      once = true;
    } else if (token === "--dry-run") {
      dryRun = true;
    } else if (token === "--supervisor-config") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) {
        return { once, dryRun, rest, error: "--supervisor-config needs a file." };
      }
      configFile = value;
      i += 1;
    } else {
      rest.push(token ?? "");
    }
  }
  return { once, dryRun, rest, ...(configFile === undefined ? {} : { configFile }) };
}

function stamp(now: Date): string {
  return now.toISOString().replace(/\D/g, "").slice(0, 14);
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}
