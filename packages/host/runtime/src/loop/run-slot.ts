import { spawn } from "node:child_process";
import { killAndCut, ownGroup, track } from "./process-tree.js";

/** A slot that writes without end is not one whose answer can be read. */
const OUTPUT_LIMIT_CHARS = 8 * 1024 * 1024;

export type SlotRun = {
  /** Set when the slot could not run, ran past its ceiling, or wrote too much. */
  error?: Error;
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
}): Promise<SlotRun> {
  return new Promise((resolve) => {
    let settled = false;
    let failure: Error | undefined;
    let stdout = "";
    let stderr = "";
    let timer: NodeJS.Timeout | undefined;

    const finish = (status: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      resolve({ ...(failure === undefined ? {} : { error: failure }), status, stdout, stderr });
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

    timer = setTimeout(
      () => {
        failure ??= new Error(`killed after ${input.timeoutMs}ms, its own ceiling`);
        killAndCut(child);
      },
      Math.max(1, input.timeoutMs),
    );
  });
}
