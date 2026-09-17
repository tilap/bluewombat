import { runChild } from "../child/run-child.js";
import type { ProgressWriter } from "../progress/emit.js";
import { emitStatusEvent } from "../progress/emit.js";
import type { Status } from "../types.js";

/**
 * Announce Status on stdout (and optionally via --on-status).
 * --on-status never affects the run outcome.
 */
export async function announceStatus(input: {
  onStatusArgv: string[] | undefined;
  status: Status;
  write: ProgressWriter;
  shouldInterrupt: () => boolean;
  cwd: string | undefined;
}): Promise<void> {
  const { status, write, shouldInterrupt, cwd } = input;
  emitStatusEvent(write, status);

  const onStatus = input.onStatusArgv;
  if (onStatus === undefined) {
    return;
  }

  const argv = [...onStatus];
  if (status.key !== undefined) {
    argv.push("--key", status.key);
  }
  argv.push("--label", status.label, "--phase", status.phase);

  // Soft cap only: a hang or non-zero exit must not change the run outcome.
  await runChild({
    argv,
    cwd,
    timeoutMs: 5_000,
    timeoutClock: "planner",
    shouldInterrupt,
  });
}
