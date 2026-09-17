import { mkdir } from "node:fs/promises";
import type { IsolationBackend } from "@bluewombat/isolator";
import { copyWorkingFiles } from "./copy-working-files.js";

/**
 * Isolation by directory copy. No git bookkeeping.
 */
export const copyIsolation: IsolationBackend = {
  async attach(input) {
    await mkdir(input.child);
    await copyWorkingFiles({
      from: input.parent,
      to: input.child,
      skipGitAtRoot: false,
      shouldStop: input.shouldStop,
    });
    return { ok: true };
  },
  async abort() {
    // A copy leaves no bookkeeping on the Parent.
  },
};
