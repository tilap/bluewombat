import type { FoldBackend } from "@bluewombat/integrator";
import { gitMerge } from "./git-merge.js";

/**
 * Fold by three-way git merge. Never forced.
 */
export const gitFold: FoldBackend = {
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
