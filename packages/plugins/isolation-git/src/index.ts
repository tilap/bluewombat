/**
 * Isolation by git worktree: attach adds a worktree then copies dirty files;
 * fold is a three-way merge; a reference work line is a remote and a branch,
 * kept as a single-branch clone. Host loads this when `workLine.isolation` is
 * `@bluewombat/isolation-git`, and hands `workLine.isolationOptions` to
 * `createStrategy` when the config has any.
 */

export { branchNameOf } from "./branch-name.js";
export { DEFAULT_EXCLUDES, isExcluded } from "./copy-working-files.js";
export { gitReference } from "./reference.js";
export type { GitIdentity } from "./run-env.js";
export { clearRunEnv, runEnv, setRunEnv } from "./run-env.js";
export { createStrategy, strategy } from "./strategy.js";
export type {
  IsolationStrategy,
  ParsedReference,
  ReferenceBackend,
  ReferenceCopyState,
} from "./types.js";
