import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { WorkLedger } from "@bluewombat/work-ledger";
import { parseJournalChunk } from "../loop/journal.js";
import { detailOf } from "../loop/trace.js";
import { compareKeys } from "./board.js";
import { isQuietJournalLine } from "./film.js";
import type { Install } from "./install.js";

/** Enough of the journal's end to know what each Ticket did last; the rest is `mason log`'s. */
const JOURNAL_TAIL_BYTES = 512 * 1024;

export type Zone = "active" | "upcoming" | "past";

export type DashRow = {
  kind: "feature" | "ticket";
  key: string;
  state: string;
  title?: string;
  /** What the board says after the state: the Submission, why it stopped. */
  detail: string;
  priority: number;
  /** The Feature a Ticket belongs to. */
  feature?: string;
  /** Keys it waits on that are not `done` yet. */
  waitingOn: string[];
  /** The last thing the journal says about it. */
  last?: { at: number; what: string };
};

export type Worker =
  | { running: true; pid: number; since: number | undefined; version: string | undefined }
  | {
      running: false;
      /** `killed`: the film has a start and no stop, so the process went without saying so. */
      ended: "clean" | "killed" | "never";
      at: number | undefined;
      version: string | undefined;
    };

export type Dash = {
  now: number;
  install: Install;
  worker: Worker;
  active: DashRow[];
  upcoming: DashRow[];
  /** Newest first. */
  past: DashRow[];
};

export function zoneOf(kind: DashRow["kind"], state: string): Zone {
  if (state === "done" || state === "cancelled") {
    return "past";
  }
  if (kind === "feature") {
    return state === "waiting" ? "upcoming" : "active";
  }
  return state === "received" ? "upcoming" : "active";
}

export type DashInput = {
  ledger: WorkLedger;
  journalPath: string;
  holder: number | undefined;
  install: Install;
  now: number;
};

export async function dashOf(input: DashInput): Promise<Dash> {
  const film = readTail(input.journalPath);
  const lastByKey = lastEvents(film);
  const states = new Map<string, string>();
  const rows: DashRow[] = [];

  for (const summary of await input.ledger.list()) {
    states.set(summary.key, summary.state);
  }
  for (const summary of await input.ledger.listFeatures()) {
    states.set(summary.key, summary.state);
  }

  for (const summary of await input.ledger.list()) {
    const got = await input.ledger.get(summary.key);
    const intention = got.ok ? got.aggregate.intention : undefined;
    const row: DashRow = {
      kind: "ticket",
      key: summary.key,
      state: summary.state,
      detail: got.ok ? detailOf(got.aggregate) : "",
      priority: summary.priority,
      waitingOn: pending(intention?.blocked_by, states),
    };
    if (intention?.title !== undefined) {
      row.title = intention.title;
    }
    if (summary.feature !== undefined) {
      row.feature = summary.feature;
    }
    rows.push(withLast(row, lastByKey));
  }
  for (const summary of await input.ledger.listFeatures()) {
    const got = await input.ledger.getFeature(summary.key);
    if (!got.ok) {
      continue;
    }
    const feature = got.aggregate;
    const row: DashRow = {
      kind: "feature",
      key: summary.key,
      state: feature.state,
      detail: featureDetail(feature.state, feature),
      priority: summary.priority,
      waitingOn: pending(feature.intention.blocked_by, states),
    };
    if (feature.intention.title !== undefined) {
      row.title = feature.intention.title;
    }
    rows.push(withLast(row, lastByKey));
  }

  const inZone = (zone: Zone): DashRow[] => rows.filter((r) => zoneOf(r.kind, r.state) === zone);
  return {
    now: input.now,
    install: input.install,
    worker: workerOf(input.holder, film),
    active: inZone("active").sort(activeOrder),
    upcoming: inZone("upcoming").sort(byKeyThenKind),
    past: inZone("past").sort(
      (a, b) => (b.last?.at ?? 0) - (a.last?.at ?? 0) || byKeyThenKind(a, b),
    ),
  };
}

/** A person is needed first, then what is being worked on, then what sits with the Authority. */
const ACTIVE_RANK: Record<string, number> = {
  escalated: 0,
  invalid: 1,
  running: 2,
  integrating: 3,
  open: 3,
  merging: 4,
  submitted: 5,
};

function activeOrder(a: DashRow, b: DashRow): number {
  return (ACTIVE_RANK[a.state] ?? 9) - (ACTIVE_RANK[b.state] ?? 9) || byKeyThenKind(a, b);
}

function byKeyThenKind(a: DashRow, b: DashRow): number {
  return compareKeys(a.key, b.key) || (a.kind === b.kind ? 0 : a.kind === "feature" ? -1 : 1);
}

function pending(blockedBy: string[] | undefined, states: Map<string, string>): string[] {
  return (blockedBy ?? []).filter((key) => states.get(key) !== "done");
}

function featureDetail(
  state: string,
  feature: {
    submission?: { reference: string };
    integration_reference?: string;
    escalation?: { kind?: string };
  },
): string {
  if (state === "submitted" || state === "done") {
    return feature.submission?.reference ?? feature.integration_reference ?? "";
  }
  return state === "escalated" ? `${feature.escalation?.kind ?? "?"} — waiting for a human` : "";
}

function withLast(row: DashRow, lastByKey: Map<string, DashRow["last"]>): DashRow {
  const last = lastByKey.get(row.key);
  return last === undefined ? row : { ...row, last };
}

/** The last non-quiet line that names each key. */
function lastEvents(film: Record<string, unknown>[]): Map<string, DashRow["last"]> {
  const found = new Map<string, DashRow["last"]>();
  for (const line of film) {
    if (typeof line.key !== "string" || isQuietJournalLine(line)) {
      continue;
    }
    const at = typeof line.at === "string" ? Date.parse(line.at) : Number.NaN;
    if (Number.isNaN(at)) {
      continue;
    }
    found.set(line.key, { at, what: shortWhat(line) });
  }
  return found;
}

function shortWhat(line: Record<string, unknown>): string {
  const event = typeof line.event === "string" ? line.event : "event";
  const extra = [line.phase, line.label, line.outcome, line.verdict].find(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  return extra === undefined ? event : `${event} ${extra}`;
}

function workerOf(holder: number | undefined, film: Record<string, unknown>[]): Worker {
  const marks = film.filter((l) => l.event === "host-started" || l.event === "host-stopped");
  const lastMark = marks.at(-1);
  const lastStart = [...marks].reverse().find((l) => l.event === "host-started");
  if (holder !== undefined) {
    // The lock names the process; the film says since when, and which version it is.
    const mine = [...marks].reverse().find((l) => l.event === "host-started" && l.pid === holder);
    return { running: true, pid: holder, since: atOf(mine), version: versionOf(mine) };
  }
  const ended =
    lastMark === undefined ? "never" : lastMark.event === "host-stopped" ? "clean" : "killed";
  return { running: false, ended, at: atOf(lastMark), version: versionOf(lastStart) };
}

function atOf(line: Record<string, unknown> | undefined): number | undefined {
  const at = typeof line?.at === "string" ? Date.parse(line.at) : Number.NaN;
  return Number.isNaN(at) ? undefined : at;
}

function versionOf(line: Record<string, unknown> | undefined): string | undefined {
  return typeof line?.version === "string" ? line.version : undefined;
}

function readTail(path: string): Record<string, unknown>[] {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - JOURNAL_TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString("utf8");
    if (start > 0) {
      // The cut falls inside a line: drop that line rather than misread it.
      const newline = text.indexOf("\n");
      text = newline < 0 ? "" : text.slice(newline + 1);
    }
    return parseJournalChunk(text, "").lines;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

export type TreeNode = {
  row: DashRow;
  /** What it still waits on besides its parent. */
  alsoWaitingOn: string[];
  children: TreeNode[];
};

/**
 * What is not over, as a forest: a row hangs under the first thing it waits on
 * (or under its Feature when it waits on nothing), so a reader sees what a stop
 * holds back. A row waiting on several things appears once, under the first,
 * and names the others.
 */
export function treeOf(dash: Pick<Dash, "active" | "upcoming">): TreeNode[] {
  const rows = [...dash.active, ...dash.upcoming];
  const nodes = new Map<string, TreeNode>(
    rows.map((row) => [row.key, { row, alsoWaitingOn: [], children: [] }]),
  );
  const parentOf = (row: DashRow): string | undefined =>
    row.waitingOn.find((key) => nodes.has(key)) ??
    (row.feature !== undefined && nodes.has(row.feature) ? row.feature : undefined);
  const roots: TreeNode[] = [];
  for (const row of rows) {
    const node = nodes.get(row.key);
    const parent = parentOf(row);
    if (node === undefined) {
      continue;
    }
    node.alsoWaitingOn = row.waitingOn.filter((key) => key !== parent);
    const holder =
      parent === undefined || reaches(nodes, parent, row.key, parentOf)
        ? undefined
        : nodes.get(parent);
    (holder?.children ?? roots).push(node);
  }
  return roots;
}

/** Following parents from `from`, do we come back to `target`? A cycle in the tracker must not loop the screen. */
function reaches(
  nodes: Map<string, TreeNode>,
  from: string,
  target: string,
  parentOf: (row: DashRow) => string | undefined,
): boolean {
  const seen = new Set<string>();
  let at: string | undefined = from;
  while (at !== undefined && !seen.has(at)) {
    if (at === target) {
      return true;
    }
    seen.add(at);
    const node = nodes.get(at);
    at = node === undefined ? undefined : parentOf(node.row);
  }
  return false;
}
