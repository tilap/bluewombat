import { type ChildProcess, spawn } from "node:child_process";
import type { ClockName } from "../types.js";

const OUTPUT_TRUNCATE = 8_192;
const OUTPUT_LIMIT_CHARS = 8 * 1024 * 1024;

export type SpawnRequest = {
  argv: string[];
  /** Undefined lets the child inherit the caller's directory. */
  cwd?: string | undefined;
  /** Wall-clock budget for this child (ms). */
  timeoutMs: number;
  /** Which clock owns the nearer deadline when timeoutMs hits. */
  timeoutClock: ClockName;
  /** When true, treat kill as interrupted (stop signal). */
  shouldInterrupt: () => boolean;
  /** Undefined lets the child inherit the caller's environment. */
  env?: NodeJS.ProcessEnv | undefined;
  /** Layered on top of the inherited environment. Ignored when `env` is set. */
  envOverrides?: NodeJS.ProcessEnv | undefined;
};

/**
 * The one place ambient environment enters a child. `env` replaces it outright;
 * `envOverrides` layers on top of what the child would inherit anyway.
 */
function childEnv(request: SpawnRequest): NodeJS.ProcessEnv | undefined {
  if (request.env !== undefined) {
    return request.env;
  }
  if (request.envOverrides !== undefined) {
    return { ...process.env, ...request.envOverrides };
  }
  return undefined;
}

export type SpawnOutcome =
  | {
      kind: "exited";
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      stdout: string;
      stderr: string;
    }
  | {
      kind: "timed_out";
      clock: ClockName;
      stdout: string;
      stderr: string;
    }
  | {
      kind: "interrupted";
      stdout: string;
      stderr: string;
    }
  | {
      kind: "spawn_error";
      detail: string;
    };

function truncate(text: string): string {
  if (text.length <= OUTPUT_TRUNCATE) {
    return text;
  }
  return `${text.slice(0, OUTPUT_TRUNCATE)}…[truncated]`;
}

function killProcessTree(child: ChildProcess): void {
  try {
    child.kill("SIGKILL");
  } catch {
    // already gone
  }
}

/**
 * Run one child with a wall-clock timeout. Does not inherit Integrator stdin.
 */
export function runChild(request: SpawnRequest): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    const [file, ...args] = request.argv;
    if (file === undefined) {
      resolve({ kind: "spawn_error", detail: "Empty command." });
      return;
    }

    let settled = false;
    let timedOut = false;
    let interrupted = false;
    let stdout = "";
    let stderr = "";
    let timer: NodeJS.Timeout | undefined;
    let interruptPoll: NodeJS.Timeout | undefined;

    const finish = (outcome: SpawnOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (interruptPoll !== undefined) {
        clearInterval(interruptPoll);
      }
      resolve(outcome);
    };

    let child: ChildProcess;
    try {
      child = spawn(file, args, {
        cwd: request.cwd,
        env: childEnv(request),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      finish({ kind: "spawn_error", detail });
      return;
    }

    if (!child.stdout || !child.stderr) {
      finish({ kind: "spawn_error", detail: "Child stdout/stderr pipes unavailable." });
      return;
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let overflowed = false;
    const take = (chunk: string): boolean => {
      if (overflowed) {
        return false;
      }
      if (stdout.length + stderr.length + chunk.length > OUTPUT_LIMIT_CHARS) {
        overflowed = true;
        killProcessTree(child);
        return false;
      }
      return true;
    };
    child.stdout.on("data", (chunk: string) => {
      if (take(chunk)) {
        stdout += chunk;
      }
    });
    child.stderr.on("data", (chunk: string) => {
      if (take(chunk)) {
        stderr += chunk;
      }
    });

    child.on("error", (error) => {
      finish({ kind: "spawn_error", detail: error.message });
    });

    timer = setTimeout(
      () => {
        timedOut = true;
        killProcessTree(child);
      },
      Math.max(1, request.timeoutMs),
    );

    interruptPoll = setInterval(() => {
      if (request.shouldInterrupt()) {
        interrupted = true;
        killProcessTree(child);
      }
    }, 20);

    if (request.shouldInterrupt()) {
      interrupted = true;
      killProcessTree(child);
    }

    child.on("close", (exitCode, signal) => {
      const out = truncate(stdout);
      const err = truncate(stderr);
      if (overflowed) {
        finish({
          kind: "spawn_error",
          detail: `Child wrote more than ${OUTPUT_LIMIT_CHARS} characters; its answer cannot be read.`,
        });
        return;
      }
      if (interrupted || request.shouldInterrupt()) {
        finish({ kind: "interrupted", stdout: out, stderr: err });
        return;
      }
      if (timedOut) {
        finish({ kind: "timed_out", clock: request.timeoutClock, stdout: out, stderr: err });
        return;
      }
      finish({ kind: "exited", exitCode, signal, stdout: out, stderr: err });
    });
  });
}

export function combinedOutput(stdout: string, stderr: string): string {
  const parts = [stdout, stderr].filter((p) => p.length > 0);
  return truncate(parts.join("\n"));
}
