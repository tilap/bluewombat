import { type ChildProcess, spawn } from "node:child_process";

export type FetchResult =
  | { kind: "merged"; object: Record<string, unknown> }
  | { kind: "empty" }
  | { kind: "unavailable"; detail: string }
  | { kind: "interrupted" };

export type FetchRequest = {
  argv: string[];
  timeoutMs: number;
  shouldInterrupt: () => boolean;
};

const OUTPUT_TRUNCATE = 8_192;

function truncate(text: string): string {
  return text.length <= OUTPUT_TRUNCATE ? text : `${text.slice(0, OUTPUT_TRUNCATE)}…[truncated]`;
}

/**
 * Run the enrichment command. Every failure is `unavailable`, never `invalid`:
 * a Fetch that did not answer says nothing about the intention.
 */
export function runFetch(request: FetchRequest): Promise<FetchResult> {
  return new Promise((resolve) => {
    const [file, ...args] = request.argv;
    if (file === undefined) {
      resolve({ kind: "unavailable", detail: "Empty Fetch command." });
      return;
    }

    let settled = false;
    let timedOut = false;
    let interrupted = false;
    let stdout = "";
    let stderr = "";
    let timer: NodeJS.Timeout | undefined;
    let interruptPoll: NodeJS.Timeout | undefined;

    const finish = (result: FetchResult): void => {
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
      resolve(result);
    };

    let child: ChildProcess;
    try {
      child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      finish({
        kind: "unavailable",
        detail: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      finish({ kind: "unavailable", detail: error.message });
    });

    timer = setTimeout(
      () => {
        timedOut = true;
        kill(child);
      },
      Math.max(1, request.timeoutMs),
    );

    interruptPoll = setInterval(() => {
      if (request.shouldInterrupt()) {
        interrupted = true;
        kill(child);
      }
    }, 20);

    child.on("close", (exitCode) => {
      if (interrupted || request.shouldInterrupt()) {
        finish({ kind: "interrupted" });
        return;
      }
      if (timedOut) {
        finish({
          kind: "unavailable",
          detail: `The Fetch was killed after ${request.timeoutMs}ms.`,
        });
        return;
      }
      if (exitCode !== 0) {
        finish({
          kind: "unavailable",
          detail: `The Fetch exited ${exitCode}. ${truncate(stderr).trim()}`.trim(),
        });
        return;
      }
      finish(readFetchStdout(stdout));
    });
  });
}

/** Exported for tests: the stdout contract of the Fetch, without a process. */
export function readFetchStdout(stdout: string): FetchResult {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return { kind: "empty" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { kind: "unavailable", detail: `The Fetch stdout is not JSON: ${detail}` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "unavailable", detail: "The Fetch stdout is not a JSON object." };
  }
  return { kind: "merged", object: parsed as Record<string, unknown> };
}

function kill(child: ChildProcess): void {
  try {
    child.kill("SIGKILL");
  } catch {
    // already gone
  }
}
