import type { IsolationBackend } from "@bluewombat/isolator";
import { branchNameOf } from "./branch-name.js";
import { copyWorkingFiles, DEFAULT_EXCLUDES, wipeWorkingFiles } from "./copy-working-files.js";
import { addGitWorktree, removeGitWorktree } from "./git-worktree.js";

export type GitIsolationOptions = {
  /** Paths that never reach a Child; see `isExcluded` for the shape. */
  exclude: readonly string[];
};

/**
 * Isolation by git worktree, then a working-file copy so the Child matches the
 * Parent's dirty tree, not only HEAD — less what `exclude` names.
 */
export function createGitIsolation(options: GitIsolationOptions): IsolationBackend {
  return {
    async attach(input) {
      const branch = input.id === undefined ? undefined : branchNameOf(input.id);
      const added = await addGitWorktree({
        parent: input.parent,
        child: input.child,
        ...(branch === undefined ? {} : { branch }),
        timeoutMs: input.timeoutMs,
        shouldInterrupt: input.shouldInterrupt,
      });
      if (!added.ok) {
        return added;
      }
      const stop = input.shouldStop();
      if (stop !== undefined) {
        return { ok: false, stop };
      }
      await wipeWorkingFiles(input.child, input.shouldStop);
      await copyWorkingFiles({
        from: input.parent,
        to: input.child,
        skipGitAtRoot: true,
        exclude: options.exclude,
        shouldStop: input.shouldStop,
      });
      return { ok: true };
    },
    async abort(input) {
      await removeGitWorktree(input);
    },
  };
}

/** The backend with nothing but the default exclusions. */
export const gitIsolation: IsolationBackend = createGitIsolation({ exclude: DEFAULT_EXCLUDES });
