import { runChild } from "../child/run-child.js";
import type { ProgressWriter } from "../progress/emit.js";
import { emitStatusEvent } from "../progress/emit.js";
import type { Invocation, Status } from "../types.js";

/**
 * Announce Status on stdout (and optionally via --on-status).
 * --on-status never affects the run outcome.
 */
export async function announceStatus(input: {
  invocation: Invocation;
  status: Status;
  write: ProgressWriter;
  shouldInterrupt: () => boolean;
  cwd: string | undefined;
}): Promise<void> {
  const { invocation, status, write, shouldInterrupt, cwd } = input;
  emitStatusEvent(write, invocation.id, status);

  const onStatus = invocation.onStatusArgv;
  if (onStatus === undefined) {
    return;
  }

  const argv = [
    ...onStatus,
    "--id",
    invocation.id,
    "--label",
    status.label,
    "--phase",
    status.phase,
  ];
  if (status.attempt !== undefined) {
    argv.push("--attempt", String(status.attempt));
  }
  if (status.max_attempts !== undefined) {
    argv.push("--max-attempts", String(status.max_attempts));
  }
  if (status.gate_id !== undefined) {
    argv.push("--gate-id", status.gate_id);
  }

  // Soft cap only: a hang or non-zero exit must not change the run outcome.
  await runChild({
    argv,
    cwd,
    timeoutMs: 5_000,
    shouldInterrupt,
  });
}
