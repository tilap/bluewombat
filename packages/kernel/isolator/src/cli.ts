#!/usr/bin/env node
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "./args/parse-args.js";
import type { IsolationBackend } from "./isolate/backend.js";
import { createStdoutProgressWriter } from "./progress/emit.js";
import { invalidInvocationResult, runIsolator } from "./run/run-isolator.js";

/**
 * Process signals belong to the binary, not to the Transformer: a Transformer imported into
 * a host must not hijack the host's SIGINT. The CLI owns the flag it passes in.
 */
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

/**
 * Load an isolation strategy package. Same contract Host uses: export `strategy`.
 */
async function loadStrategy(
  specifier: string,
): Promise<{ ok: true; isolation: IsolationBackend } | { ok: false; reason: string }> {
  let url = specifier;
  if (specifier.startsWith(".") || isAbsolute(specifier)) {
    const path = resolve(process.cwd(), specifier);
    if (!existsSync(path)) {
      return { ok: false, reason: `Strategy "${specifier}" is not a file: ${path}` };
    }
    url = pathToFileURL(path).href;
  }
  let loaded: unknown;
  try {
    loaded = await import(url);
  } catch (error) {
    return {
      ok: false,
      reason: `Strategy "${specifier}" could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const strategy = (loaded as { strategy?: unknown }).strategy;
  if (
    strategy === null ||
    typeof strategy !== "object" ||
    typeof (strategy as { isolation?: unknown }).isolation !== "object" ||
    strategy === undefined
  ) {
    return {
      ok: false,
      reason: `Strategy "${specifier}" does not export strategy with an isolation backend.`,
    };
  }
  return { ok: true, isolation: (strategy as { isolation: IsolationBackend }).isolation };
}

async function main(argv: string[]): Promise<number> {
  const write = createStdoutProgressWriter();
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    const result = await invalidInvocationResult({
      id: parsed.id,
      onStatusArgv: parsed.onStatusArgv,
      write,
      reason: parsed.reason,
      cwd: process.cwd(),
    });
    return result.exitCode;
  }

  const loaded = await loadStrategy(parsed.strategy);
  if (!loaded.ok) {
    const result = await invalidInvocationResult({
      id: parsed.invocation.id,
      onStatusArgv: parsed.invocation.onStatusArgv,
      write,
      reason: loaded.reason,
      cwd: process.cwd(),
    });
    return result.exitCode;
  }

  const interruptFlag = { interrupted: false };
  const detachSignals = installSignalHandlers(interruptFlag);
  try {
    const result = await runIsolator({
      invocation: parsed.invocation,
      backend: loaded.isolation,
      write,
      interruptFlag,
      cwd: process.cwd(),
    });
    return result.exitCode;
  } finally {
    detachSignals();
  }
}

const exitCode = await main(process.argv.slice(2));
process.exitCode = exitCode;
