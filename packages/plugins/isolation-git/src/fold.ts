import type { FoldBackend } from "@bluewombat/integrator";
import { workingPaths } from "./copy-working-files.js";
import { gitMerge } from "./git-merge.js";

/**
 * Fold by three-way git merge. Never forced. A failed fold restores the
 * working files git sees, not what `.gitignore` leaves out: the merge never
 * writes there, and `node_modules/` is most of a workspace.
 */
export const gitFold: FoldBackend = {
  snapshotPaths: workingPaths,
  async fold(input) {
    return await gitMerge({
      parent: input.parent,
      child: input.child,
      ...(input.id === undefined ? {} : { id: input.id }),
      ...(input.subject === undefined ? {} : { subject: input.subject }),
      ...(input.mergeSubject === undefined ? {} : { mergeSubject: input.mergeSubject }),
      deadlineMs: input.deadlineMs,
      now: input.now,
      shouldInterrupt: input.shouldInterrupt,
    });
  },
};
