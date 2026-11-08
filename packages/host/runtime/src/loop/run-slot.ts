import { spawn } from "node:child_process";
import { killAndCut, ownGroup, track } from "./process-tree.js";

/** A slot that writes without end is not one whose answer can be read. */
const OUTPUT_LIMIT_CHARS = 8 * 1024 * 1024;

/** How often the clock is looked at, and how far behind a look may be before the process was not running. */
const BEAT_MS = 1_000;
const SUSPENDED_AFTER_MS = 10_000;

/**
 * Time the clock ran while this process did not: the machine asleep, a VM paused, the process stopped.
 * A look that comes much later than it should have means nothing ran in between. Same on every system.
 */
export function watchSuspension(
  now: () => number = Date.now,
  beatMs = BEAT_MS,
  afterMs = SUSPENDED_AFTER_MS,
): { suspendedMs: () => number; stop: () => void } {
  let last = now();
  let suspended = 0;
  const beat = setInterval(() => {
    const at = now();
    if (at - last > afterMs) {
      suspended += at - last - beatMs;
    }
    last = at;
  }, beatMs);
  beat.unref();
  return { suspendedMs: () => suspended, stop: () => clearInterval(beat) };
}

function minutes(ms: number): string {
  return ms < 90_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)} min`;
}

export type SlotRun = {
  /** Set when the slot could not run, ran past its ceiling, or wrote too much. */
  error?: Error;
  /** True when the ceiling is what ended it: whatever it wrote before is still in `stdout`. */
  atCeiling: boolean;
  /** Milliseconds the clock ran while this process did not (machine asleep, paused). 0 when none. */
  suspendedMs: number;
  status: number | null;
  stdout: string;
  stderr: string;
};

/**
 * Run a slot (Publisher, Refresher, Describer) to its end or to its ceiling.
 *
 * At the ceiling the whole process tree goes, not just the command: a slot is
 * a script that starts an agent that starts shells, and a `spawnSync` timeout
 * stops only the first while the rest holds the pipes open until it ends on its
 * own. Never throws.
 */
export function runSlot(input: {
  command: string;
  args: string[];
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  timeoutMs: number;
  /** The clock the suspension watcher reads; tests move it. */
  now?: (() => number) | undefined;
}): Promise<SlotRun> {
  return new Promise((resolve) => {
    let settled = false;
    let failure: Error | undefined;
    let stdout = "";
    let stderr = "";
    let timer: NodeJS.Timeout | undefined;
    let atCeiling = false;
    const asleep = watchSuspension(input.now);

    const finish = (status: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      asleep.stop();
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      resolve({
        ...(failure === undefined ? {} : { error: failure }),
        atCeiling,
        suspendedMs: asleep.suspendedMs(),
        status,
        stdout,
        stderr,
      });
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(input.command, input.args, {
        cwd: input.cwd,
        env: input.env,
        stdio: ["ignore", "pipe", "pipe"],
        ...ownGroup(),
      });
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
      finish(null);
      return;
    }
    track(child);

    const take = (chunk: string): boolean => {
      if (stdout.length + stderr.length + chunk.length > OUTPUT_LIMIT_CHARS) {
        failure ??= new Error(`wrote more than ${OUTPUT_LIMIT_CHARS} characters`);
        killAndCut(child);
        return false;
      }
      return true;
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (take(chunk)) {
        stdout += chunk;
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      if (take(chunk)) {
        stderr += chunk;
      }
    });

    child.on("error", (error) => {
      failure ??= error;
      finish(null);
    });
    child.on("close", (status) => {
      finish(status);
    });

    // The ceiling is working time: each time it fires, it is pushed back by
    // the time the process was suspended since the last look.
    let granted = 0;
    const arm = (ms: number): void => {
      timer = setTimeout(
        () => {
          const extension = asleep.suspendedMs() - granted;
          if (extension > 0) {
            granted += extension;
            arm(extension);
            return;
          }
          atCeiling = failure === undefined;
          failure ??= new Error(
            `killed after ${input.timeoutMs}ms, its own ceiling${
              granted === 0
                ? ""
                : `, not counting ${minutes(granted)} while this process was not running (the machine asleep or paused)`
            }`,
          );
          killAndCut(child);
        },
        Math.max(1, ms),
      );
    };
    arm(input.timeoutMs);
  });
}
