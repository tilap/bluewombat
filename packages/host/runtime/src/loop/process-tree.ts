import { type ChildProcess, execFileSync } from "node:child_process";

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
//
// The group is not the whole tree. A vendor CLI may start each shell command
// in a group of its own (cursor-agent does), out of the group's reach. So the
// descendants are read from `ps` first — once their parent dies they are
// re-parented and the link is lost — and each is killed too.

/** Windows has no process groups: there a child is killed alone. */
const OWN_GROUP = process.platform !== "win32";

/**
 * After a kill the pipes are cut this long afterwards, so a grandchild that
 * left the group (setsid) and still holds one cannot hold the outcome back.
 */
const PIPE_GRACE_MS = 2_000;

const live = new Set<ChildProcess>();
/** Already killed: a supervisor polling its interrupt asks again every tick. */
const ended = new WeakSet<ChildProcess>();
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

/**
 * Every process below `pid`, as `ps` lists them now. Empty where `ps` cannot be
 * read: the group kill still stands.
 */
function descendants(pid: number): number[] {
  let table: string;
  try {
    table = execFileSync("ps", ["-A", "-o", "pid=,ppid="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return [];
  }
  const childrenOf = new Map<number, number[]>();
  for (const line of table.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (match !== null) {
      const parent = Number(match[2]);
      childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), Number(match[1])]);
    }
  }
  const found: number[] = [];
  let frontier = [pid];
  while (frontier.length > 0) {
    frontier = frontier.flatMap((each) => childrenOf.get(each) ?? []);
    found.push(...frontier);
  }
  return found;
}

/**
 * SIGKILL to the child's whole group and to every descendant, wherever its
 * group; to the child alone where there are no groups. Once per child.
 */
export function killTree(child: ChildProcess): void {
  if (ended.has(child)) {
    return;
  }
  ended.add(child);
  if (OWN_GROUP && child.pid !== undefined) {
    const below = descendants(child.pid);
    let grouped = true;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // no such group: the child itself, below
      grouped = false;
    }
    for (const pid of below) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone, with the group
      }
    }
    if (grouped) {
      return;
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // already gone
  }
}

/** `killTree`, then the pipes are cut after the grace period. Once per child. */
export function killAndCut(child: ChildProcess): void {
  if (ended.has(child)) {
    return;
  }
  killTree(child);
  setTimeout(() => {
    child.stdout?.destroy();
    child.stderr?.destroy();
  }, PIPE_GRACE_MS).unref();
}
