import { CLI_NAME } from "@bluewombat/manager-kit";
import { parseArgs } from "../config/parse-args.js";
import type { HostOptions } from "../config/types.js";
import { openHost } from "../loop/open-host.js";
import { resolveKey } from "./incident.js";

export type RestartInput = {
  cwd: string;
  argv: string[];
  env?: Record<string, string | undefined>;
  write: (line: string) => void;
  interruptFlag?: { interrupted: boolean };
};

/**
 * Resume an escalated Feature with a fresh workspace.
 *
 * What the Feature's work holds is removed and the Feature is resumed, so the
 * next `run` makes it again from the line and judges that. It is the offline
 * way out when the work itself is what is wrong: a resume alone keeps it. It
 * says nothing to the tracker and fetches nothing. It takes the ledger lock:
 * stop `run` first if it holds it.
 */
export async function runRestart(input: RestartInput): Promise<number> {
  const first = input.argv[0];
  if (first === undefined || first.startsWith("-")) {
    input.write(`Usage: ${CLI_NAME} restart <feature-key>\n`);
    return 2;
  }
  const parsed = parseArgs(input.argv.slice(1), { cwd: input.cwd });
  if (!parsed.ok) {
    input.write(`${parsed.reason}\n`);
    return 2;
  }

  const options: HostOptions = {
    ...parsed.invocation,
    interruptFlag: input.interruptFlag ?? { interrupted: false },
    ...(input.env === undefined ? {} : { env: input.env }),
  };
  let host: Awaited<ReturnType<typeof openHost>> | undefined;
  try {
    host = await openHost(options);
    const found = await resolveKey(host.ledger, first);
    if (!found.ok) {
      input.write(`${found.reason}\n`);
      return 2;
    }
    if (!("kind" in found.subject)) {
      input.write(`${found.subject.intention.key} is a Ticket: restart takes a Feature.\n`);
      return 2;
    }
    const key = found.subject.intention.key;
    const result = await host.restart(key);
    if (result.ok) {
      input.write(
        `Restarted ${key}: its workspace is removed.\nThe next ${CLI_NAME} run makes it again from the line and judges it.\n`,
      );
      return 0;
    }
    if (result.code === "not-found") {
      input.write(`No Feature named "${key}" in the ledger.\n`);
      return 2;
    }
    input.write(`${key} is ${result.state}: only an escalated Feature restarts.\n`);
    return 1;
  } catch (error) {
    input.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  } finally {
    await host?.close();
  }
}
