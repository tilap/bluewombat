import { runSlot } from "../../loop/run-slot.js";

export type ExecResult = {
  /** Null when the command never ran or was cut at its ceiling. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Milliseconds the clock ran while the supervisor did not (machine asleep, paused). */
  suspendedMs?: number;
  /** The ceiling ended it; what it wrote before is in `stdout`. */
  atCeiling?: boolean;
  /** Why it did not run to its end, when it did not. */
  error?: string;
};

export type Exec = (
  cmd: string[],
  options: { cwd?: string; timeoutMs: number },
) => Promise<ExecResult>;

/** The supervisor's one way to start anything: a command, a ceiling, a result. Never throws. */
export const exec: Exec = async (cmd, options) => {
  const [command, ...args] = cmd;
  if (command === undefined) {
    return { code: null, stdout: "", stderr: "", error: "empty command" };
  }
  const run = await runSlot({
    command,
    args,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    timeoutMs: options.timeoutMs,
  });
  return {
    code: run.status,
    stdout: run.stdout,
    stderr: run.stderr,
    ...(run.atCeiling ? { atCeiling: true } : {}),
    ...(run.suspendedMs > 0 ? { suspendedMs: run.suspendedMs } : {}),
    ...(run.error === undefined ? {} : { error: run.error.message }),
  };
};

/**
 * Replace `{name}` in each word of a command. A name nobody gave stays as
 * written. A word that is only `{name}` and names a list becomes that list's
 * words, so `{addDirArgs}` can stand for any number of `--add-dir X` pairs.
 */
export function fill(
  cmd: string[],
  vars: Record<string, string>,
  lists: Record<string, string[]> = {},
): string[] {
  return cmd.flatMap((word) => {
    const whole = /^\{(\w+)\}$/.exec(word)?.[1];
    if (whole !== undefined && lists[whole] !== undefined) {
      return lists[whole];
    }
    return [word.replace(/\{(\w+)\}/g, (all, name) => vars[name] ?? all)];
  });
}

export function succeeded(result: ExecResult): boolean {
  return result.code === 0 && result.error === undefined;
}

/** What a failed command said, cut to what a reader needs. */
export function tail(result: ExecResult, chars = 4000): string {
  const text = [result.error, result.stderr, result.stdout]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join("\n");
  return text.length > chars ? `…${text.slice(-chars)}` : text;
}
