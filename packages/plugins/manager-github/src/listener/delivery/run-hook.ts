import { type ChildProcess, spawn } from "node:child_process";
import { killTree, ownGroup, track } from "./process-tree.js";

/** Soft cap: --on-intention must not hold the subscription open forever. */
const HOOK_TIMEOUT_MS = 5_000;

/**
 * Run --on-intention for one Delivery. The result is deliberately dropped:
 * a non-zero exit, a missing command, or a hang never changes the run outcome
 * and never rolls the Cursor back.
 */
/** `cwd` undefined lets the hook inherit the caller's directory. */
export function runHook(argv: string[], cwd: string | undefined): Promise<void> {
  return new Promise((resolve) => {
    const [file, ...args] = argv;
    if (file === undefined) {
      resolve();
      return;
    }

    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      resolve();
    };

    let child: ChildProcess;
    try {
      child = spawn(file, args, { cwd, stdio: ["ignore", "ignore", "ignore"], ...ownGroup() });
      track(child);
    } catch {
      finish();
      return;
    }

    timer = setTimeout(() => {
      killTree(child);
      finish();
    }, HOOK_TIMEOUT_MS);

    child.on("error", finish);
    child.on("close", finish);
  });
}
