import type { ChildProcess } from "node:child_process";

// Canonical source of every `process-tree.ts` in this repository. Edit it here,
// then run `node scripts/check-process-tree.mjs --write`; `npm run lint` fails
// when a copy differs. A package stands alone, so each carries its own copy.
//
// The rule it keeps: whoever starts a child and owns its deadline — a
// supervisor — starts it as the leader of its own process group, and ends it by
// signalling that group. A child is rarely alone: a producer is `node producer`
// → `node agent` → the vendor CLI → its shells. Killing only the first leaves
// the rest running, holding the pipes open, until they end on their own; the
// deadline then means nothing and a finished job is reported as lost.
//
// A layer in the middle of such a chain (a producer, an agent runner) is not a
// supervisor: it starts its child in its own group, so the supervisor's signal
// reaches it too.

/** Windows has no process groups: there a child is killed alone. */
const OWN_GROUP = process.platform !== "win32";

/**
 * After a kill the pipes are cut this long afterwards, so a grandchild that
 * left the group (setsid) and still holds one cannot hold the outcome back.
 */
const PIPE_GRACE_MS = 2_000;

const live = new Set<ChildProcess>();
let exitHookInstalled = false;

/** Spread into the options of `spawn`: the child leads its own group. */
export function ownGroup(): { detached: boolean } {
  return { detached: OWN_GROUP };
}

/**
 * Remember a running child so it does not outlive this process: a group of its
 * own no longer shares the terminal's Ctrl-C, nor dies by accident with us.
 * Forgotten on its own once it closes.
 */
export function track(child: ChildProcess): void {
  if (OWN_GROUP && !exitHookInstalled) {
    exitHookInstalled = true;
    process.on("exit", () => {
      for (const running of live) {
        killTree(running);
      }
    });
  }
  live.add(child);
  const forget = (): void => {
    live.delete(child);
  };
  child.once("close", forget);
  child.once("error", forget);
}

/** SIGKILL to the child's whole group; to the child alone where there is none. */
export function killTree(child: ChildProcess): void {
  if (OWN_GROUP && child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // no such group: fall through to the child itself
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // already gone
  }
}

/** `killTree`, then the pipes are cut after the grace period. */
export function killAndCut(child: ChildProcess): void {
  killTree(child);
  setTimeout(() => {
    child.stdout?.destroy();
    child.stderr?.destroy();
  }, PIPE_GRACE_MS).unref();
}
