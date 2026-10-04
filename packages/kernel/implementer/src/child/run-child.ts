import { type ChildProcess, spawn } from "node:child_process";
import type { ChildSink } from "../types.js";
import { killAndCut, ownGroup, track } from "./process-tree.js";

// Two bounds, for two different things.
//
// The first protects this process: a child that writes without end is not one
// whose answer can be read, so past this much it is killed and reported as
// broken. No sane child comes near it, and nothing a child says is cut by it.
const OUTPUT_LIMIT_CHARS = 8 * 1024 * 1024;
// The second protects the ledger: when a child left no contract line, its
// stdout and stderr become the report, and only their end — where a crash says
// why — is kept. Same size as the tracker keeps of a report.
const REPORT_KEEP_CHARS = 8_192;

export type SpawnRequest = {
  argv: string[];
  /** Undefined lets the child inherit the caller's directory. */
  cwd?: string | undefined;
  /** Wall-clock budget for this child (ms). */
  timeoutMs: number;
  /** When true, treat kill as interrupted (stop signal). */
  shouldInterrupt: () => boolean;
  /** Undefined lets the child inherit the caller's environment. */
  env?: NodeJS.ProcessEnv | undefined;
  /**
   * Opened once the child is running, closed when it settles. Absent, or
   * answering nothing: its output is not filmed, which is the default.
   */
  openSink?: (() => ChildSink | undefined) | undefined;
};

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

function keepEnd(text: string): string {
  if (text.length <= REPORT_KEEP_CHARS) {
    return text;
  }
  return `[…${text.length - REPORT_KEEP_CHARS} characters cut]${text.slice(-REPORT_KEEP_CHARS)}`;
}

/**
 * Run one child with a wall-clock timeout. Does not inherit Implementer stdin.
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
    let sink: ChildSink | undefined;

    const finish = (outcome: SpawnOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      // `settled` already guards this block, so the sink is closed once on
      // every path out: exited, timed out, interrupted, or over the bound.
      sink?.close();
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
        env: request.env,
        stdio: ["ignore", "pipe", "pipe"],
        ...ownGroup(),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      finish({ kind: "spawn_error", detail });
      return;
    }

    track(child);

    if (!child.stdout || !child.stderr) {
      finish({ kind: "spawn_error", detail: "Child stdout/stderr pipes unavailable." });
      return;
    }

    // After the spawn: a child that never started has no output to film, and
    // that path has already resolved.
    sink = request.openSink?.();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let overflowed = false;
    const take = (chunk: string): boolean => {
      if (overflowed) {
        return false;
      }
      if (stdout.length + stderr.length + chunk.length > OUTPUT_LIMIT_CHARS) {
        overflowed = true;
        killAndCut(child);
        return false;
      }
      return true;
    };
    // The sink is fed before the bound, deliberately. `take` protects this
    // process's memory; a sink writes elsewhere and accumulates nothing. A child
    // killed for saying too much is exactly the one whose words are worth
    // keeping, and cutting the film at the same place would lose them.
    child.stdout.on("data", (chunk: string) => {
      sink?.write("stdout", chunk);
      if (take(chunk)) {
        stdout += chunk;
      }
    });
    child.stderr.on("data", (chunk: string) => {
      sink?.write("stderr", chunk);
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
        killAndCut(child);
      },
      Math.max(1, request.timeoutMs),
    );

    interruptPoll = setInterval(() => {
      if (request.shouldInterrupt()) {
        interrupted = true;
        killAndCut(child);
      }
    }, 20);

    if (request.shouldInterrupt()) {
      interrupted = true;
      killAndCut(child);
    }

    child.on("close", (exitCode, signal) => {
      const out = stdout;
      const err = stderr;
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
        finish({ kind: "timed_out", stdout: out, stderr: err });
        return;
      }
      finish({ kind: "exited", exitCode, signal, stdout: out, stderr: err });
    });
  });
}

/** The fallback report of a child that left no contract line: its last words. */
export function combinedOutput(stdout: string, stderr: string): string {
  const parts = [stdout, stderr].filter((p) => p.length > 0);
  return keepEnd(parts.join("\n"));
}
