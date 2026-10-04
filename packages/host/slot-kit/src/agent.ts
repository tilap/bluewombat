import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * What every slot that drives an agent CLI needs, and nothing about any one of
 * them. A Builder and a Planner answer different contracts; finding a binary,
 * running it and reading its result is the same work twice.
 */

/**
 * First executable among `names`, looked up name by name so a precise name
 * anywhere wins over a generic one early on PATH. PATH first, then the
 * directories an installer is known to use.
 */
export function findExecutable(
  names: readonly string[],
  extraDirs: readonly string[] = [],
): string | undefined {
  const dirs = [...(process.env.PATH ?? "").split(delimiter), ...extraDirs].filter(
    (dir) => dir.length > 0,
  );
  for (const name of names) {
    for (const dir of dirs) {
      const candidate = join(dir, name);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // try the next directory
      }
    }
  }
  return undefined;
}

export type AgentRun = {
  /** Absent when the CLI never started. */
  code?: number | null | undefined;
  signal?: NodeJS.Signals | null | undefined;
  /** Set when the CLI never started. */
  error?: Error | undefined;
  stdout: string;
  stderr: string;
  /** Both streams in arrival order. */
  output: string;
  startedAt: Date;
  endedAt: Date;
  durationMs: number;
};

export type AgentInvocation = {
  file: string;
  args: readonly string[];
  cwd: string;
};

/**
 * Run the agent to completion, streaming its output to stderr as it comes so
 * an operator can watch. stdout stays the contract channel of the slot.
 *
 * Resolves with `output` — both streams in arrival order, which is what a
 * failure report should quote — `stdout` alone, which is what a structured
 * `--output-format` has to be parsed from, and `stderr` alone, which is where
 * an agent says what it did.
 */
export function runAgent({ file, args, cwd }: AgentInvocation): Promise<AgentRun> {
  return new Promise((resolve) => {
    const startedAt = new Date();
    // process-tree:layer — started in this process's own group, never a group of
    // its own: whoever supervises this slot ends the whole chain with one signal.
    const child = spawn(file, [...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let output = "";
    let settled = false;

    const settle = (result: Partial<AgentRun>): void => {
      if (settled) {
        return;
      }
      settled = true;
      process.off("SIGTERM", stop);
      process.off("SIGINT", stop);
      const endedAt = new Date();
      resolve({
        stdout,
        output,
        ...result,
        stderr,
        startedAt,
        endedAt,
        durationMs: endedAt.getTime() - startedAt.getTime(),
      });
    };
    const stop = (): void => {
      // process-tree:allow — a layer, in the supervisor's group: its signal
      // reaches the shells below the agent. This is for a human's Ctrl-C.
      child.kill("SIGKILL");
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      output += chunk;
      process.stderr.write(chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      output += chunk;
      process.stderr.write(chunk);
    });

    child.on("error", (error) => {
      settle({ error, stdout, output });
    });
    child.on("exit", (code, signal) => {
      settle({ code, signal, stdout, output });
    });
  });
}

/**
 * Token counts a vendor reported for one run. `costUsd` is only present when
 * the vendor said so (Claude documents `total_cost_usd`; Cursor's json result
 * does not).
 */
export type AgentUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number | null;
};

/**
 * What the agent did with its tools, as its vendor's stream told it. The
 * question a reader of a run asks first — did it read that page, did it go
 * outside its directory, did it hand work off — answered without reading the
 * stream.
 */
export type AgentTools = {
  /** Calls per tool, under the vendor's own name for it. */
  calls: Record<string, number>;
  /** Wall time with at least one tool running; `null` when the stream carries no times. */
  busyMs: number | null;
  /** Pages fetched, searches, and URLs a shell command named. */
  web: string[];
  /** MCP calls, as `server/tool`, one entry per call. */
  mcp: string[];
  /** Subagents handed work, by the description they were given. */
  subagents: string[];
  /** Paths a tool named outside the working directory; skill files excepted. */
  outside: string[];
};

/**
 * Optional facts a vendor wrapper extracted from the run. Always present on
 * the serialized line: `null` means the wrapper did not learn them (unknown),
 * an empty `skills` array means it looked and found none.
 */
export type AgentExtras = {
  skills: string[] | null;
  usage: AgentUsage | null;
  tools: AgentTools | null;
};

/**
 * What an agent CLI writes on stdout so the role that spawned it can classify
 * the run. Dates and `Error` do not survive JSON, so they are strings here.
 * `skills` and `usage` are always set: `null` is unknown, not "empty".
 */
export type SerializedRun = {
  name: string;
  bin: string;
  code: number | null;
  signal: string | null;
  error?: string;
  stdout: string;
  stderr: string;
  output: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  skills: string[] | null;
  usage: AgentUsage | null;
  tools: AgentTools | null;
};

export type SerializeAbout = {
  name: string;
  bin: string;
  skills?: string[] | null;
  usage?: AgentUsage | null;
  tools?: AgentTools | null;
};

/** The JSON an agent CLI writes after a vendor run. */
export function serializeRun(run: AgentRun, about: SerializeAbout): SerializedRun {
  return {
    name: about.name,
    bin: about.bin,
    code: run.code ?? null,
    signal: run.signal ?? null,
    ...(run.error === undefined ? {} : { error: run.error.message }),
    stdout: run.stdout,
    stderr: run.stderr,
    output: run.output,
    startedAt: run.startedAt.toISOString(),
    endedAt: run.endedAt.toISOString(),
    durationMs: run.durationMs,
    skills: about.skills === undefined ? null : about.skills,
    usage: about.usage === undefined ? null : about.usage,
    tools: about.tools === undefined ? null : about.tools,
  };
}

/**
 * Rebuild the run an agent CLI serialized. `undefined` when the payload is not
 * one — a pre-run refusal is `{ error }` with no `startedAt`.
 */
export function deserializeRun(raw: Record<string, unknown>): AgentRun | undefined {
  if (typeof raw.startedAt !== "string" || typeof raw.endedAt !== "string") {
    return undefined;
  }
  const signal = raw.signal;
  return {
    code: typeof raw.code === "number" ? raw.code : null,
    signal: typeof signal === "string" ? (signal as NodeJS.Signals) : null,
    ...(typeof raw.error === "string" ? { error: new Error(raw.error) } : {}),
    stdout: typeof raw.stdout === "string" ? raw.stdout : "",
    stderr: typeof raw.stderr === "string" ? raw.stderr : "",
    output: typeof raw.output === "string" ? raw.output : "",
    startedAt: new Date(raw.startedAt),
    endedAt: new Date(raw.endedAt),
    durationMs: typeof raw.durationMs === "number" ? raw.durationMs : 0,
  };
}

/** `skills` / `usage` / `tools` from a serialized line; `null` when absent or malformed. */
export function extrasOf(raw: Record<string, unknown>): AgentExtras {
  return {
    skills: skillsOf(raw.skills),
    usage: usageOf(raw.usage),
    tools: toolsOf(raw.tools),
  };
}

function toolsOf(value: unknown): AgentTools | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const calls = record.calls;
  const lists = [record.web, record.mcp, record.subagents, record.outside];
  if (
    calls === null ||
    typeof calls !== "object" ||
    Array.isArray(calls) ||
    Object.values(calls).some((count) => typeof count !== "number") ||
    lists.some((list) => !Array.isArray(list) || list.some((item) => typeof item !== "string")) ||
    !(record.busyMs === null || typeof record.busyMs === "number")
  ) {
    return null;
  }
  return {
    calls: calls as Record<string, number>,
    busyMs: record.busyMs as number | null,
    web: record.web as string[],
    mcp: record.mcp as string[],
    subagents: record.subagents as string[],
    outside: record.outside as string[],
  };
}

function skillsOf(value: unknown): string[] | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    return null;
  }
  return value;
}

function usageOf(value: unknown): AgentUsage | null {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.input !== "number" ||
    typeof record.output !== "number" ||
    typeof record.cacheRead !== "number" ||
    typeof record.cacheWrite !== "number"
  ) {
    return null;
  }
  const costUsd =
    record.costUsd === null ? null : typeof record.costUsd === "number" ? record.costUsd : null;
  return {
    input: record.input,
    output: record.output,
    cacheRead: record.cacheRead,
    cacheWrite: record.cacheWrite,
    costUsd,
  };
}

/** The CLI's own result object: the last line of stdout that is one. */
export function readResult(stdout: string): Record<string, unknown> | undefined {
  const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line === undefined) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // not this line
    }
  }
  return undefined;
}
