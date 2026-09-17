#!/usr/bin/env node
import { PRODUCT } from "@bluewombat/manager-kit";
import { CONFIG_FILENAME } from "./config/find-config.js";
import { DEFAULT_HOME } from "./config/home.js";
import { parseArgs } from "./config/parse-args.js";
import type { HostOptions } from "./config/types.js";
import { openHost } from "./loop/open-host.js";
import { runCancel } from "./operator/cancel.js";
import { runDoctor } from "./operator/doctor.js";
import { runInit } from "./operator/init.js";
import { runLive } from "./operator/live.js";
import { isInteractive, terminalAsk } from "./operator/prompt.js";
import { runSetup } from "./operator/setup.js";

const USAGE = `Usage: ${PRODUCT} <command>

  run      drain the FeatureManager, run Conductor, report
  watch    snapshot the ledger and follow the journal
  status   snapshot the ledger, then exit
  cancel   abandon a Feature by key (when the tracker cannot say it is gone)
  init     set this directory up — asks, writes, then runs setup
  doctor   check the config, the slots, and the manager
  setup    prepare the tracker (--apply to write; a plan without it)

init flags:   --manager PKG --manager-option KEY=VALUE --work-line-stable DIR
              --clone REMOTE [--branch NAME] --force --interactive

Shared flags: --config FILE --manager NAME --manager-option KEY=VALUE --home DIR
              --work-line-stable DIR --work-line-branch NAME --workspace-root DIR --ledger DIR
              --planner -- CMD --planner-timeout-ms N
              --builder -- CMD --builder-timeout-ms N --builder-max-attempts N
              --builder-repair -- CMD --builder-repair-timeout-ms N
              --builder-gate ID -- CMD --builder-gate-timeout-ms N
              --assembly-fix -- CMD --assembly-fix-timeout-ms N --assembly-max-attempts N
              --assembly-gate ID -- CMD --assembly-gate-timeout-ms N
              --timeout-ms N --poll-interval-ms N

A gate's --*-gate-timeout-ms comes before the --*-gate it bounds.

watch / status also take --json (snapshot as JSON).

Without --config, the nearest ${CONFIG_FILENAME} is used. --home is where Host
keeps its own files (default ${DEFAULT_HOME}): the ledger, the workspaces, its copy of
the work line.
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
  const parsed = parseArgs(argv, { cwd: process.cwd() });
  if (!parsed.ok) {
    process.stderr.write(`${parsed.reason}\n`);
    return 2;
  }

  const interruptFlag = { interrupted: false };
  const options: HostOptions = { ...parsed.invocation, interruptFlag };
  const detachSignals = installSignalHandlers(interruptFlag);
  let host: Awaited<ReturnType<typeof openHost>> | undefined;
  try {
    host = await openHost(options);
    const result = await host.run();
    if (result.lastRun?.outcome === "refused") {
      return 1;
    }
    return interruptFlag.interrupted ? 130 : 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  } finally {
    await host?.close();
    detachSignals();
  }
}

async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  const rest = argv.slice(1);
  if (command === "run") {
    return await run(rest);
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
  process.stderr.write(USAGE);
  return 2;
}

const exitCode = await main(process.argv.slice(2));
process.exitCode = exitCode;
