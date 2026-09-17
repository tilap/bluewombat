import type { FoldBackend } from "@bluewombat/integrator";
import { copyMerge } from "./copy-merge.js";

/**
 * Fold by directory merge. Same-type bytes take the Child.
 */
export const copyFold: FoldBackend = {
  async fold(input) {
    return await copyMerge({
      parent: input.parent,
      child: input.child,
      shouldStop: input.shouldStop,
    });
  },
};
