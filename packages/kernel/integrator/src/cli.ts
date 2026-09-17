#!/usr/bin/env node
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "./args/parse-args.js";
import type { FoldBackend } from "./fold/backend.js";
import { createStdoutProgressWriter } from "./progress/emit.js";
import { invalidInvocationResult, runIntegrator } from "./run/run-integrator.js";

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
): Promise<{ ok: true; fold: FoldBackend } | { ok: false; reason: string }> {
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
    typeof (strategy as { fold?: unknown }).fold !== "object" ||
    strategy === undefined
  ) {
    return {
      ok: false,
      reason: `Strategy "${specifier}" does not export strategy with a fold backend.`,
    };
  }
  return { ok: true, fold: (strategy as { fold: FoldBackend }).fold };
}

async function main(argv: string[]): Promise<number> {
  const write = createStdoutProgressWriter();
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    const result = await invalidInvocationResult({
      cwd: process.cwd(),
      id: parsed.id,
      onStatusArgv: parsed.onStatusArgv,
      write,
      reason: parsed.reason,
    });
    return result.exitCode;
  }

  const loaded = await loadStrategy(parsed.strategy);
  if (!loaded.ok) {
    const result = await invalidInvocationResult({
      cwd: process.cwd(),
      id: parsed.invocation.id,
      onStatusArgv: parsed.invocation.onStatusArgv,
      write,
      reason: loaded.reason,
    });
    return result.exitCode;
  }

  const interruptFlag = { interrupted: false };
  const detachSignals = installSignalHandlers(interruptFlag);
  try {
    const result = await runIntegrator({
      invocation: parsed.invocation,
      backend: loaded.fold,
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
