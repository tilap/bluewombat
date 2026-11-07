import { openWorkLedger } from "@bluewombat/work-ledger";
import { parseArgs } from "../config/parse-args.js";
import { journalPath } from "../loop/journal.js";
import { liveLockHolder } from "../loop/lock.js";
import { openPersist } from "../plugins/persist.js";
import { dashOf } from "./dash-model.js";
import { renderDash } from "./dash-view.js";
import { installOf } from "./install.js";

export type DashInput = {
  cwd: string;
  argv: string[];
  write: (text: string) => void;
  interruptFlag: { interrupted: boolean };
  /** Present at a terminal: the screen is redrawn in place. Absent (a pipe), one frame is printed. */
  screen?: {
    columns: number;
    rows: number;
    color: boolean;
    size: () => { columns: number; rows: number };
  };
  /** Keys typed at the terminal: `t` flips list and tree, `r` redraws, `q` or Ctrl-C leaves. Absent, the screen answers to no key. */
  keys?: { subscribe: (onKey: (key: string) => void) => () => void };
  /** Which view to open on. */
  tree?: boolean;
  /** Tests shrink this. */
  now?: () => number;
};

const DEFAULT_INTERVAL_MS = 2000;
const FOOTER = "t list/tree · r redraw · q quit";
const ENTER = "\x1b[?1049h\x1b[?25l";
const LEAVE = "\x1b[?25h\x1b[?1049l";
const HOME = "\x1b[H";
const CLEAR_LINE_END = "\x1b[K";
const CLEAR_BELOW = "\x1b[J";

type Flags = {
  tree: boolean;
  once: boolean;
  noColor: boolean;
  intervalMs: number;
  rest: string[];
  error?: string;
};

/**
 * A dashboard of the ledger that redraws itself: the version, whether the worker
 * is there, what is being worked on, what is next, what just finished.
 *
 * Like `watch`, it opens the ledger and the journal and nothing else.
 */
export async function runDash(input: DashInput): Promise<number> {
  const flags = peelFlags(input.argv);
  if (flags.error !== undefined) {
    input.write(`${flags.error}\n`);
    return 2;
  }
  const parsed = parseArgs(flags.rest, { cwd: input.cwd, checkPaths: false });
  if (!parsed.ok) {
    input.write(`${parsed.reason}\n`);
    return 2;
  }
  try {
    const opened = await openPersist(
      parsed.invocation.persist,
      parsed.invocation.configDir,
      parsed.invocation.ledgerRoot,
    );
    if (!opened.ok) {
      input.write(`${opened.reason}\n`);
      return 2;
    }
    const ledger = openWorkLedger({ persist: opened.persist });
    const install = installOf();
    const path = journalPath(parsed.invocation.ledgerRoot);
    const view = { tree: input.tree === true || flags.tree, wake: false };
    const frame = async (): Promise<string[]> => {
      const dash = await dashOf({
        ledger,
        journalPath: path,
        holder: await liveLockHolder(parsed.invocation.ledgerRoot),
        install,
        now: (input.now ?? Date.now)(),
      });
      const size = input.screen?.size() ?? { columns: 100, rows: 40 };
      return renderDash(dash, {
        width: size.columns,
        height: size.rows,
        color: input.screen?.color === true && !flags.noColor,
        mode: view.tree ? "tree" : "list",
        ...(input.keys === undefined || flags.once ? {} : { footer: FOOTER }),
      });
    };

    const screen = input.screen;
    if (screen === undefined || flags.once) {
      input.write(`${(await frame()).join("\n")}\n`);
      return 0;
    }
    input.write(ENTER);
    const unsubscribe = input.keys?.subscribe((key) => {
      if (key === "q" || key === "\x03") {
        input.interruptFlag.interrupted = true;
      } else if (key === "t") {
        view.tree = !view.tree;
      }
      view.wake = true;
    });
    try {
      while (!input.interruptFlag.interrupted) {
        const lines = await frame();
        input.write(
          `${HOME}${lines.map((l) => `${l}${CLEAR_LINE_END}`).join("\n")}\n${CLEAR_BELOW}`,
        );
        view.wake = false;
        await sleep(flags.intervalMs, input.interruptFlag, view);
      }
    } finally {
      unsubscribe?.();
      input.write(LEAVE);
    }
    return 0;
  } catch (error) {
    input.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

function peelFlags(argv: string[]): Flags {
  const flags: Flags = {
    tree: false,
    once: false,
    noColor: false,
    intervalMs: DEFAULT_INTERVAL_MS,
    rest: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? "";
    if (token === "--once") {
      flags.once = true;
    } else if (token === "--tree") {
      flags.tree = true;
    } else if (token === "--no-color") {
      flags.noColor = true;
    } else if (token === "--interval-ms") {
      const raw = argv[i + 1];
      if (raw === undefined || !/^\d+$/.test(raw) || Number(raw) < 200) {
        return { ...flags, error: "--interval-ms needs a number of at least 200." };
      }
      flags.intervalMs = Number(raw);
      i += 1;
    } else {
      flags.rest.push(token);
    }
  }
  return flags;
}

/** Sleeps until the time is up, the run is interrupted, or a key asked for a redraw. */
function sleep(
  ms: number,
  interruptFlag: { interrupted: boolean },
  view: { wake: boolean },
): Promise<void> {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = (): void => {
      if (interruptFlag.interrupted || view.wake || Date.now() - started >= ms) {
        resolve();
        return;
      }
      setTimeout(tick, Math.min(50, ms));
    };
    tick();
  });
}
