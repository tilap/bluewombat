import { homedir } from "node:os";
import { CLI_NAME } from "@bluewombat/manager-kit";
import {
  type Dash,
  type DashRow,
  type TreeNode,
  treeOf,
  type Worker,
  zoneOf,
} from "./dash-model.js";

export type DashStyle = {
  /** Terminal columns; rows are cut to fit. */
  width: number;
  /** Terminal rows; the lists share what the header and section titles leave. */
  height: number;
  color: boolean;
  /** `tree` hangs what waits under what it waits on; default `list`. */
  mode?: "list" | "tree";
  /** A last line, for the keys the screen answers to. */
  footer?: string;
};

const ICONS: Record<string, string> = {
  received: "⏳",
  waiting: "⏳",
  running: "🔨",
  open: "🔨",
  integrating: "🧩",
  submitted: "📬",
  merging: "🔀",
  escalated: "🛑",
  invalid: "❗",
  done: "✅",
  cancelled: "🚫",
};

type Paint = "red" | "green" | "yellow" | "blue" | "dim" | "bold";
const CODES: Record<Paint, string> = {
  red: "31",
  green: "32",
  yellow: "33",
  blue: "34",
  dim: "2",
  bold: "1",
};
const STATE_PAINT: Record<string, Paint> = {
  running: "blue",
  open: "blue",
  integrating: "blue",
  submitted: "yellow",
  merging: "yellow",
  escalated: "red",
  invalid: "red",
  done: "green",
  cancelled: "dim",
  received: "dim",
  waiting: "dim",
};

const STATE_WIDTH = 11;
/** A section always shows at least this many rows, however short the terminal. */
const MIN_ROWS = 3;

/** The whole frame as lines. Pure: the same Dash and style give the same frame. */
export function renderDash(dash: Dash, style: DashStyle): string[] {
  const paint = (text: string, how: Paint): string =>
    style.color ? `\x1b[${CODES[how]}m${text}\x1b[0m` : text;
  const lines: string[] = [];
  lines.push(...headerOf(dash, paint));
  if (style.mode === "tree") {
    lines.push(...treeLines(dash, style, paint));
    if (style.footer !== undefined) {
      lines.push(paint(style.footer, "dim"));
    }
    return lines;
  }

  // 2 header lines + 3 section titles + 1 footer.
  const budget = Math.max(MIN_ROWS * 3, style.height - 6);
  const sizes = split(budget, [dash.active.length, dash.upcoming.length, dash.past.length]);
  const all = [...dash.active, ...dash.upcoming, ...dash.past];
  const prefix = commonPrefix(all.map((r) => r.key));
  const short = (key: string): string => key.slice(prefix.length);
  const keyWidth = Math.max(0, ...all.map((r) => short(r.key).length));
  const section = (
    title: string,
    rows: DashRow[],
    size: number,
    now: number,
    showLast: boolean,
  ): void => {
    lines.push(paint(`${title} (${rows.length})`, "bold"));
    if (rows.length === 0) {
      lines.push(paint("  —", "dim"));
      return;
    }
    // A hidden tail still counts: "+N more" takes the last row's place.
    const shown = rows.length > size ? rows.slice(0, Math.max(0, size - 1)) : rows;
    for (const row of shown) {
      lines.push(rowLine(row, { keyWidth, now, width: style.width, paint, short, showLast }));
    }
    if (shown.length < rows.length) {
      lines.push(paint(`  … +${rows.length - shown.length} more`, "dim"));
    }
  };
  section("ACTIVE", dash.active, sizes[0] ?? MIN_ROWS, dash.now, true);
  section("UPCOMING", dash.upcoming, sizes[1] ?? MIN_ROWS, dash.now, false);
  section("PAST", dash.past, sizes[2] ?? MIN_ROWS, dash.now, true);
  if (style.footer !== undefined) {
    lines.push(paint(style.footer, "dim"));
  }
  return lines;
}

type Flat = { node: TreeNode; indent: string };

/** Everything still to do, as a tree; what is over is only counted. */
function treeLines(
  dash: Dash,
  style: DashStyle,
  paint: (text: string, how: Paint) => string,
): string[] {
  const roots = treeOf(dash);
  const flat: Flat[] = [];
  const walk = (nodes: TreeNode[], lead: string): void => {
    nodes.forEach((node, index) => {
      const last = index === nodes.length - 1;
      flat.push({
        node,
        indent: lead === "" && nodes === roots ? "" : `${lead}${last ? "└─ " : "├─ "}`,
      });
      walk(node.children, nodes === roots ? "" : `${lead}${last ? "   " : "│  "}`);
    });
  };
  walk(roots, "");
  // Children of a root hang from column 0.
  const prefix = commonPrefix([...dash.active, ...dash.upcoming, ...dash.past].map((r) => r.key));
  const short = (key: string): string => key.slice(prefix.length);
  const keyWidth = Math.max(
    0,
    ...flat.map(({ node, indent }) => indent.length + short(node.row.key).length),
  );
  const lines = [paint(`TO DO (${flat.length})  ·  ${dash.past.length} over`, "bold")];
  // 2 header + 1 title + 1 footer.
  const room = Math.max(MIN_ROWS, style.height - 4);
  const shown = flat.length > room ? flat.slice(0, Math.max(0, room - 1)) : flat;
  for (const { node, indent } of shown) {
    const row = { ...node.row, waitingOn: node.alsoWaitingOn };
    lines.push(
      rowLine(row, {
        keyWidth,
        now: dash.now,
        width: style.width,
        paint,
        short,
        showLast: zoneOf(row.kind, row.state) === "active",
        indent,
      }),
    );
  }
  if (flat.length === 0) {
    lines.push(paint("  —", "dim"));
  } else if (shown.length < flat.length) {
    lines.push(paint(`  … +${flat.length - shown.length} more`, "dim"));
  }
  return lines;
}

function headerOf(dash: Dash, paint: (text: string, how: Paint) => string): string[] {
  const where =
    dash.install.source === "npm" ? "npm package" : `local copy ${tilde(dash.install.dir)}`;
  const first = `${CLI_NAME} ${dash.install.version} · ${where}`;
  return [paint(first, "bold"), `${workerText(dash.worker, dash.now, paint)}${versionNote(dash)}`];
}

function versionNote(dash: Dash): string {
  const theirs = dash.worker.version;
  return theirs !== undefined && theirs !== dash.install.version
    ? `  ⚠️  the worker runs ${theirs}, this command ${dash.install.version}`
    : "";
}

function workerText(
  worker: Worker,
  now: number,
  paint: (text: string, how: Paint) => string,
): string {
  if (worker.running) {
    const up = worker.since === undefined ? "" : ` · up ${age(now - worker.since)}`;
    return `${paint("🟢 running", "green")}  pid ${worker.pid}${up}`;
  }
  const when = worker.at === undefined ? "" : ` ${age(now - worker.at)} ago`;
  switch (worker.ended) {
    case "clean":
      return `${paint("⚫ stopped", "dim")}  stopped${when}`;
    case "killed":
      return `${paint("🔴 stopped", "red")}  died without saying so (last sign${when})`;
    default:
      return `${paint("⚫ stopped", "dim")}  no run recorded in this ledger`;
  }
}

function rowLine(
  row: DashRow,
  ctx: {
    keyWidth: number;
    now: number;
    width: number;
    paint: (t: string, h: Paint) => string;
    short: (key: string) => string;
    /** An upcoming row has only ever been "reported": that says nothing. */
    showLast: boolean;
    /** The branch drawn before the icon, in a tree. */
    indent?: string;
  },
): string {
  const icon = ICONS[row.state] ?? "▫️";
  const indent = ctx.indent ?? "";
  const lead = `${indent}${icon} ${ctx.short(row.key).padEnd(ctx.keyWidth - indent.length)}  `;
  const state = ctx.paint(row.state.padEnd(STATE_WIDTH), STATE_PAINT[row.state] ?? "dim");
  // Icon is two columns wide however many code points it takes.
  const used = 2 + 1 + ctx.keyWidth + 2 + STATE_WIDTH + 2;
  // (the indent is part of keyWidth: columns line up whatever the depth)
  const room = Math.max(0, ctx.width - used);
  const tag = row.kind === "feature" ? "Feature " : "";
  const wait = row.waitingOn.length > 0 ? ` ⛓ ${row.waitingOn.map(ctx.short).join(", ")}` : "";
  const seen =
    row.last === undefined || !ctx.showLast
      ? ""
      : ` · ${row.last.what} ${age(ctx.now - row.last.at)}`;
  const text = [`${tag}${row.title ?? ""}`.trim(), row.detail]
    .filter((s) => s.length > 0)
    .join(" — ");
  const rest = clip(`${text}${wait}`, room);
  const tail = clip(seen, Math.max(0, room - rest.length));
  return `${lead}${state}  ${rest}${ctx.paint(tail, "dim")}`.trimEnd();
}

/** Rows each list may show: all it needs, with the leftover going to whichever needs more. */
function split(budget: number, needs: number[]): number[] {
  const sizes = needs.map(() => MIN_ROWS);
  let left = budget - MIN_ROWS * needs.length;
  for (;;) {
    const hungry = needs.findIndex((n, i) => n > (sizes[i] ?? 0));
    if (left <= 0 || hungry < 0) {
      break;
    }
    // Active is served first, then upcoming, then past.
    sizes[hungry] = (sizes[hungry] ?? 0) + 1;
    left -= 1;
  }
  return sizes;
}

export function age(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) {
    return `${s}s`;
  }
  const m = Math.floor(s / 60);
  if (m < 60) {
    return `${m}m`;
  }
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h${String(m % 60).padStart(2, "0")}` : `${Math.floor(h / 24)}d`;
}

function clip(text: string, width: number): string {
  if (width <= 0) {
    return "";
  }
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

function tilde(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

/** What every key starts with, up to and including a `#` or `:` — `github:tilap/ksmgr#` — so a row only says its number. */
function commonPrefix(keys: string[]): string {
  const first = keys[0];
  if (first === undefined) {
    return "";
  }
  let end = first.length;
  for (const key of keys) {
    while (end > 0 && !key.startsWith(first.slice(0, end))) {
      end -= 1;
    }
  }
  const head = first.slice(0, end);
  const cut = Math.max(head.lastIndexOf("#"), head.lastIndexOf(":"));
  return cut < 0 ? "" : head.slice(0, cut + 1);
}
