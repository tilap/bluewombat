import { PRODUCT } from "@bluewombat/manager-kit";
import { parseArgs } from "../config/parse-args.js";
import type { HostOptions } from "../config/types.js";
import { openHost } from "../loop/open-host.js";

export type CancelInput = {
  cwd: string;
  argv: string[];
  env?: Record<string, string | undefined>;
  write: (line: string) => void;
  interruptFlag?: { interrupted: boolean };
};

/**
 * Abandon one Feature by key.
 *
 * The team still abandons in the FeatureManager. This is the hatch when the
 * tracker cannot say the intention is gone — a manager with no `probe`, or
 * an operator who already knows — and the ledger would otherwise freeze the
 * Project. It takes the ledger lock: stop `run` first if it holds it.
 */
export async function runCancel(input: CancelInput): Promise<number> {
  const peeled = peelKey(input.argv);
  if (peeled.key === undefined) {
    input.write(`Usage: ${PRODUCT} cancel <key>\n`);
    return 2;
  }
  const { key } = peeled;

  const parsed = parseArgs(peeled.rest, { cwd: input.cwd });
  if (!parsed.ok) {
    input.write(`${parsed.reason}\n`);
    return 2;
  }

  const interruptFlag = input.interruptFlag ?? { interrupted: false };
  const options: HostOptions = {
    ...parsed.invocation,
    interruptFlag,
    ...(input.env === undefined ? {} : { env: input.env }),
  };
  let host: Awaited<ReturnType<typeof openHost>> | undefined;
  try {
    host = await openHost(options);
    const result = await host.cancel(key);
    if (result.ok) {
      input.write(`Cancelled ${key}.\n`);
      return 0;
    }
    switch (result.code) {
      case "already-cancelled":
        input.write(`Already cancelled.\n`);
        return 0;
      case "not-found":
        input.write(`No Feature named "${key}" in the ledger.\n`);
        return 2;
      case "done":
        input.write("Too late: that Feature is already done.\n");
        return 1;
      case "point-of-no-return":
        input.write("Too late: abandon is refused after merging.\n");
        return 1;
    }
    return 2;
  } catch (error) {
    input.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  } finally {
    await host?.close();
  }
}

/** The key is the first positional: `cancel <key> [flags]`. */
function peelKey(argv: string[]): { key: string | undefined; rest: string[] } {
  const first = argv[0];
  if (first === undefined || first.startsWith("-")) {
    return { key: undefined, rest: argv };
  }
  return { key: first, rest: argv.slice(1) };
}
