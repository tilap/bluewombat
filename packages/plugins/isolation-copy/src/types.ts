import type { FoldBackend } from "@bluewombat/integrator";
import type { IsolationBackend } from "@bluewombat/isolator";

/** One Isolation method: how a Child is attached, and how it folds back. */
export type IsolationStrategy = {
  isolation: IsolationBackend;
  fold: FoldBackend;
};
