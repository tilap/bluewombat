import type { IsolationStop } from "@bluewombat/isolator";
import { combinedOutput, runChild } from "./child/run-child.js";

const CLEANUP_TIMEOUT_MS = 5_000;

export type GitAddResult =
  | { ok: true }
  | { ok: false; stop: IsolationStop }
  | { ok: false; detail: string };

/**
 * Attach a git worktree at `child` from `parent`. Does not copy working files.
 *
 * `-B` points the name at the Parent's current commit whether or not it already
 * exists, so an Isolation that runs again lands where a first one would: the
 * Child is a snapshot of the Parent, never the leftovers of an earlier run.
 *
 * A Child that was deleted from disk is still registered with the Parent, and
 * git refuses to check its branch out a second time — so an Isolation that runs
 * again would fail on the trace of the first. Pruning first forgets every
 * worktree whose directory is gone, and nothing else.
 */
export async function addGitWorktree(input: {
  parent: string;
  child: string;
  branch?: string;
  timeoutMs: number;
  shouldInterrupt: () => boolean;
}): Promise<GitAddResult> {
  await runChild({
    argv: ["git", "-C", input.parent, "worktree", "prune"],
    cwd: input.parent,
    timeoutMs: CLEANUP_TIMEOUT_MS,
    timeoutClock: "isolation",
    shouldInterrupt: input.shouldInterrupt,
  });
  const placement =
    input.branch === undefined ? ["--detach", input.child] : ["-B", input.branch, input.child];
  const outcome = await runChild({
    argv: ["git", "-C", input.parent, "worktree", "add", ...placement],
    cwd: input.parent,
    timeoutMs: input.timeoutMs,
    timeoutClock: "isolation",
    shouldInterrupt: input.shouldInterrupt,
  });

  if (outcome.kind === "interrupted") {
    return { ok: false, stop: "interrupt" };
  }
  if (outcome.kind === "timed_out") {
    return { ok: false, stop: "clock" };
  }
  if (outcome.kind === "spawn_error") {
    return {
      ok: false,
      detail: `Git could not complete the Isolation: ${outcome.detail}`,
    };
  }
  if (outcome.exitCode !== 0) {
    const detail = combinedOutput(outcome.stdout, outcome.stderr) || "git worktree add failed.";
    return { ok: false, detail: `Git could not complete the Isolation: ${detail}` };
  }
  return { ok: true };
}

/**
 * Drop Isolation bookkeeping for an incomplete git Child. Best-effort.
 */
export async function removeGitWorktree(input: { parent: string; child: string }): Promise<void> {
  await runChild({
    argv: ["git", "-C", input.parent, "worktree", "remove", "--force", input.child],
    cwd: input.parent,
    timeoutMs: CLEANUP_TIMEOUT_MS,
    timeoutClock: "isolation",
    shouldInterrupt: () => false,
  });
  await runChild({
    argv: ["git", "-C", input.parent, "worktree", "prune"],
    cwd: input.parent,
    timeoutMs: CLEANUP_TIMEOUT_MS,
    timeoutClock: "isolation",
    shouldInterrupt: () => false,
  });
}
