#!/usr/bin/env node
import { CLI_NAME } from "@bluewombat/manager-kit";
import { DEFAULT_CONFIG_FILENAME } from "./config/find-config.js";
import { DEFAULT_HOME } from "./config/home.js";
import { runCancel } from "./operator/cancel.js";
import { runDoctor } from "./operator/doctor.js";
import { runExplain } from "./operator/explain.js";
import { runInit } from "./operator/init.js";
import { runLive } from "./operator/live.js";
import { runLog } from "./operator/log.js";
import { isInteractive, terminalAsk } from "./operator/prompt.js";
import { runRelease } from "./operator/release.js";
import { runRun } from "./operator/run.js";
import { runSetup } from "./operator/setup.js";

const USAGE = `Usage: ${CLI_NAME} <command>

  run      drain the tracker, run Conductor, report
  watch    snapshot the ledger and follow the journal
  status   snapshot the ledger, then exit
  log      replay the journal, including why a phase stopped
  cancel   abandon a Ticket by key (when the tracker cannot say it is gone)
  release  drop a held unit without waiting for the bail clock
  init     set this directory up — asks, writes, then runs setup
  doctor   check the config, the slots, and the manager
  explain  say what an agent role starts with: prompt, plugins, skills (read-only)
  setup    prepare the tracker (--apply to write; a plan without it)

init flags:   --config FILE --manager PKG --manager-option KEY=VALUE --work-line-stable DIR
              --clone REMOTE [--branch NAME] --force --interactive

Shared flags: --config FILE --feature-tracker NAME --feature-tracker-option KEY=VALUE
              --ticket-tracker NAME --ticket-tracker-option KEY=VALUE --home DIR
              --work-line-stable DIR --work-line-branch NAME --workspace-root DIR --ledger DIR
              --streams-dir DIR
              --builder -- CMD --builder-timeout-ms N --builder-max-attempts N
              --builder-repair -- CMD --builder-repair-timeout-ms N
              --builder-gate ID -- CMD --builder-gate-timeout-ms N
              --ticket-fix -- CMD --ticket-fix-timeout-ms N --ticket-max-attempts N
              --ticket-validate -- CMD --ticket-validate-timeout-ms N
              --ticket-gate ID -- CMD --ticket-gate-timeout-ms N
              --timeout-ms N --poll-interval-ms N

A gate's --*-gate-timeout-ms comes before the --*-gate it bounds.

watch / status also take --json (snapshot as JSON). explain takes an optional role
(builder.producer, builder.repair, ticket.fix, ticket.validate, authority.describe) and --json.

log also takes --problems, --all, and --json (every kept line).
--tail N limits the text film (0 = no limit). With --json it names kept and shown when it drops lines.

Without --config, the nearest ${DEFAULT_CONFIG_FILENAME} is used, and init writes
that name. --home is where Host keeps its own files (default ${DEFAULT_HOME}): the
ledger, the workspaces, its copy of the work line.

--streams-dir films what every child says, as it says it, one file per child.
Naming the directory is what turns it on; the config key "observability.streams"
is the same switch for good. It is off by default: a stream is the Project's own
material — its code, its prompts — written down in the clear.
`;

function installSignalHandlers(state: { interrupted: boolean }): () => void {
  const onSignal = (): void => {
    state.interrupted = true;
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  return () => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  };
}

async function run(argv: string[]): Promise<number> {
  const interruptFlag = { interrupted: false };
  const detachSignals = installSignalHandlers(interruptFlag);
  try {
    return await runRun({
      cwd: process.cwd(),
      argv,
      write: (text) => process.stdout.write(text),
      writeError: (text) => process.stderr.write(text),
      interruptFlag,
    });
  } finally {
    detachSignals();
  }
}

async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  const rest = argv.slice(1);
  if (command === "run") {
    return await run(rest);
  }
  if (command === "log") {
    return await runLog({
      cwd: process.cwd(),
      argv: rest,
      write: (line) => process.stdout.write(line),
    });
  }
  if (command === "watch" || command === "status") {
    const interruptFlag = { interrupted: false };
    const detachSignals = installSignalHandlers(interruptFlag);
    try {
      return await runLive({
        cwd: process.cwd(),
        argv: rest,
        write: (line) => process.stdout.write(line),
        interruptFlag,
        follow: command === "watch",
      });
    } finally {
      detachSignals();
    }
  }
  if (command === "init") {
    // Asking only makes sense at a terminal; a script gets the flags-only path.
    // `--interactive` forces the questions when stdin is a pipe.
    const wizard =
      (isInteractive() || rest.includes("--interactive")) && !rest.includes("--manager");
    const terminal = wizard ? terminalAsk() : undefined;
    try {
      const result = await runInit({
        cwd: process.cwd(),
        argv: rest,
        env: process.env,
        write: (line) => process.stdout.write(line),
        ...(terminal === undefined ? {} : { ask: terminal.ask }),
      });
      if (!result.ok) {
        process.stderr.write(`${result.reason}\n`);
        return result.exitCode ?? 2;
      }
      return result.exitCode;
    } finally {
      terminal?.close();
    }
  }
  if (command === "setup") {
    const interruptFlag = { interrupted: false };
    const detachSignals = installSignalHandlers(interruptFlag);
    try {
      return await runSetup({
        cwd: process.cwd(),
        argv: rest,
        env: process.env,
        write: (line) => process.stdout.write(line),
        interruptFlag,
      });
    } finally {
      detachSignals();
    }
  }
  if (command === "doctor") {
    return await runDoctor({
      cwd: process.cwd(),
      argv: rest,
      env: process.env,
      write: (line) => process.stdout.write(line),
    });
  }
  if (command === "explain") {
    return await runExplain({
      cwd: process.cwd(),
      argv: rest,
      env: process.env,
      write: (text) => process.stdout.write(text),
    });
  }
  if (command === "cancel") {
    const interruptFlag = { interrupted: false };
    const detachSignals = installSignalHandlers(interruptFlag);
    try {
      return await runCancel({
        cwd: process.cwd(),
        argv: rest,
        env: process.env,
        write: (line) => process.stdout.write(line),
        interruptFlag,
      });
    } finally {
      detachSignals();
    }
  }
  if (command === "release") {
    const interruptFlag = { interrupted: false };
    const detachSignals = installSignalHandlers(interruptFlag);
    try {
      return await runRelease({
        cwd: process.cwd(),
        argv: rest,
        env: process.env,
        write: (line) => process.stdout.write(line),
        interruptFlag,
      });
    } finally {
      detachSignals();
    }
  }
  process.stderr.write(USAGE);
  return 2;
}

const exitCode = await main(process.argv.slice(2));
process.exitCode = exitCode;
