import { PRODUCT } from "@bluewombat/manager-kit";
import { parseArgs } from "../config/parse-args.js";
import type { HostOptions } from "../config/types.js";
import { openHost } from "../loop/open-host.js";

export type ReleaseInput = {
  cwd: string;
  argv: string[];
  env?: Record<string, string | undefined>;
  write: (line: string) => void;
  interruptFlag?: { interrupted: boolean };
};

/**
 * Drop a held Subtask (or planning) by key without waiting for the bail clock.
 *
 * The hatch after a crash left a Subtask `running` with nobody on it. A clean
 * stop releases itself; this is for when the process never wrote that. Takes
 * the ledger lock: stop `run` first if it holds it.
 */
export async function runRelease(input: ReleaseInput): Promise<number> {
  const peeled = peelKey(input.argv);
  if (peeled.key === undefined) {
    input.write(`Usage: ${PRODUCT} release <key>\n`);
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
    const result = await host.release(key);
    if (result.ok) {
      input.write(result.freed ? `Released ${key}.\n` : `Already free.\n`);
      return 0;
    }
    switch (result.code) {
      case "not-found":
        input.write(`No Feature named "${key}" in the ledger.\n`);
        return 2;
      case "illegal-transition":
        input.write(
          result.state === undefined
            ? "Too late: that Feature cannot be released.\n"
            : `Too late: that Feature is ${result.state}.\n`,
        );
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

/** The key is the first positional: `release <key> [flags]`. */
function peelKey(argv: string[]): { key: string | undefined; rest: string[] } {
  const first = argv[0];
  if (first === undefined || first.startsWith("-")) {
    return { key: undefined, rest: argv };
  }
  return { key: first, rest: argv.slice(1) };
}
