#!/usr/bin/env node
import { parseArgs } from "./args/parse-args.js";
import { createStdoutProgressWriter } from "./progress/emit.js";
import { invalidInvocationResult, runImplementer } from "./run/run-implementer.js";

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

async function main(argv: string[]): Promise<number> {
  const write = createStdoutProgressWriter();
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    const result = invalidInvocationResult(undefined, write, parsed.reason);
    return result.exitCode;
  }

  const interruptFlag = { interrupted: false };
  const detachSignals = installSignalHandlers(interruptFlag);
  try {
    const result = await runImplementer({
      invocation: parsed.invocation,
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
