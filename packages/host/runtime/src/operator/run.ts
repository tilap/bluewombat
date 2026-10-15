import { parseArgs } from "../config/parse-args.js";
import type { HostOptions } from "../config/types.js";
import { openHost } from "../loop/open-host.js";
import type { Host } from "../loop/tick.js";
import { openTrace } from "../loop/trace.js";

export type RunInput = {
  cwd: string;
  argv: string[];
  /** Where the run says what it is doing: stdout. */
  write: (text: string) => void;
  /** Where a failure is explained: stderr. */
  writeError: (text: string) => void;
  interruptFlag: { interrupted: boolean };
  /** Tests hand a Host that needs no tracker. */
  open?: (options: HostOptions) => Promise<Pick<Host, "run" | "close">>;
};

/** The width the other trace lines (`listen`, `feature`, `work line`) pad their label to. */
const LABEL = 11;

function say(label: string, text: string): string {
  return `${label.padEnd(LABEL)}${text}`;
}

function nameOf(spec: { package: unknown }): string {
  return typeof spec.package === "string" ? spec.package : "(a module)";
}

/**
 * `mason run`: drain the tracker, run Conductor, report.
 *
 * It speaks before it does anything, and again at every step that can take a
 * while or fail: with nothing on the terminal there is no telling a run that
 * is starting from one that crashed. Whatever happens, the last line says that
 * it stopped and why.
 */
export async function runRun(input: RunInput): Promise<number> {
  const trace = openTrace(input.write);
  trace(say("run", "starting"));

  const parsed = parseArgs(input.argv, { cwd: input.cwd });
  if (!parsed.ok) {
    input.writeError(`${parsed.reason}\n`);
    trace(say("stopped", "not started, exit 2"));
    return 2;
  }
  const invocation = parsed.invocation;
  trace(say("config", invocation.configDir));
  trace(
    say(
      "trackers",
      `features ${nameOf(invocation.featureTracker)}, tickets ${nameOf(invocation.ticketTracker)}`,
    ),
  );
  trace(say("ledger", invocation.ledgerRoot));
  trace(
    say(
      "poll",
      invocation.pollIntervalMs === undefined
        ? "once, then stop"
        : `every ${Math.round(invocation.pollIntervalMs / 1000)}s`,
    ),
  );

  const options: HostOptions = {
    ...invocation,
    interruptFlag: input.interruptFlag,
    write: input.write,
  };
  const open = input.open ?? openHost;
  let host: Awaited<ReturnType<typeof open>> | undefined;
  try {
    trace(say("opening", "ledger, lock, work line and trackers"));
    host = await open(options);
    trace(say("started", `pid ${process.pid}, Ctrl-C to stop`));
    const result = await host.run();
    // An interrupt mid-Delivery leaves that run `refused` too: it is still an interrupt.
    if (input.interruptFlag.interrupted) {
      trace(say("stopped", "interrupted, exit 130"));
      return 130;
    }
    if (result.lastRun?.outcome === "refused") {
      trace(say("stopped", "the last run was refused, exit 1"));
      return 1;
    }
    trace(say("stopped", "finished"));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    input.writeError(`${message}\n`);
    trace(say("stopped", "failed, exit 2"));
    return 2;
  } finally {
    await host?.close();
  }
}
