import type {
  FeatureAggregate,
  FeatureState,
  TicketAggregate,
  TicketSummary,
  WorkLedger,
} from "@bluewombat/work-ledger";
import { detailOf } from "../loop/trace.js";

export type BoardTicket = {
  key: string;
  project: string;
  state: string;
  priority: number;
  received_at: number;
  bail_expires_at?: number;
  attempts_used?: number;
  escalation?: { kind: string };
  invalid?: { code: string; reason: string };
  submission?: { reference: string; refusals: number; last_report?: string };
  parked_refusal?: { report: string; refused_by?: string };
  title?: string;
  /** The Ticket holds the feature tests of its Feature. */
  feature_test?: true;
  /** What the text view says after the state; not part of the JSON. */
  detail: string;
};

export type BoardFeature = {
  key: string;
  project: string;
  state: FeatureState;
  priority: number;
  received_at: number;
  title?: string;
  escalation?: { kind?: string; report?: string };
  submission?: { reference: string };
  /** What the text view says after the state; not part of the JSON. */
  detail: string;
  tickets: BoardTicket[];
};

/** Every Feature with its Tickets, then the Tickets that belong to none. */
export type Board = { features: BoardFeature[]; tickets: BoardTicket[] };

/**
 * The one order in which keys are listed: by tracker (what comes before the
 * last `#`), then by number, so `#18` comes before `#107`.
 */
export function compareKeys(a: string, b: string): number {
  const left = splitKey(a);
  const right = splitKey(b);
  if (left.tracker !== right.tracker) {
    return left.tracker < right.tracker ? -1 : 1;
  }
  if (left.number !== right.number) {
    return left.number - right.number;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

function splitKey(key: string): { tracker: string; number: number } {
  const at = key.lastIndexOf("#");
  const number = at < 0 ? Number.NaN : Number(key.slice(at + 1));
  return Number.isInteger(number)
    ? { tracker: key.slice(0, at), number }
    : { tracker: key, number: -1 };
}

/** Escalated Features need a person; done and cancelled ones are over. */
function featureGroup(state: FeatureState): number {
  if (state === "escalated") {
    return 0;
  }
  return state === "done" || state === "cancelled" ? 2 : 1;
}

export async function boardOf(ledger: WorkLedger): Promise<Board> {
  const tickets = new Map<string, BoardTicket>();
  for (const summary of await ledger.list()) {
    const got = await ledger.get(summary.key);
    tickets.set(summary.key, got.ok ? rowOf(got.aggregate) : rowFromSummary(summary));
  }
  const features: BoardFeature[] = [];
  for (const summary of await ledger.listFeatures()) {
    const got = await ledger.getFeature(summary.key);
    if (!got.ok) {
      continue;
    }
    const members: BoardTicket[] = [];
    for (const key of got.aggregate.tickets) {
      const row = tickets.get(key);
      tickets.delete(key);
      members.push(row ?? missingRow(key, summary.project));
    }
    features.push(featureRowOf(got.aggregate, members.sort(byKey)));
  }
  features.sort(
    (a, b) => featureGroup(a.state) - featureGroup(b.state) || compareKeys(a.key, b.key),
  );
  return { features, tickets: [...tickets.values()].sort(byKey) };
}

export function byKey(a: { key: string }, b: { key: string }): number {
  return compareKeys(a.key, b.key);
}

/** A Feature names a Ticket the ledger does not hold. */
function missingRow(key: string, project: string): BoardTicket {
  return { key, project, state: "unknown", priority: 0, received_at: 0, detail: "" };
}

function featureRowOf(aggregate: FeatureAggregate, tickets: BoardTicket[]): BoardFeature {
  const row: BoardFeature = {
    key: aggregate.intention.key,
    project: aggregate.intention.project,
    state: aggregate.state,
    priority: aggregate.intention.priority,
    received_at: aggregate.received_at,
    detail: featureDetail(aggregate),
    tickets,
  };
  if (aggregate.intention.title !== undefined) {
    row.title = aggregate.intention.title;
  }
  if (aggregate.escalation !== undefined) {
    row.escalation = {};
    if (aggregate.escalation.kind !== undefined) {
      row.escalation.kind = aggregate.escalation.kind;
    }
    if (aggregate.escalation.report !== undefined) {
      row.escalation.report = aggregate.escalation.report;
    }
  }
  if (aggregate.submission !== undefined) {
    row.submission = { reference: aggregate.submission.reference };
  }
  return row;
}

function featureDetail(aggregate: FeatureAggregate): string {
  switch (aggregate.state) {
    case "submitted":
    case "done":
      return aggregate.submission?.reference ?? aggregate.integration_reference ?? "";
    case "escalated":
      return `${aggregate.escalation?.kind ?? "?"} — waiting for a human`;
    default:
      return "";
  }
}

function rowFromSummary(summary: TicketSummary): BoardTicket {
  const row: BoardTicket = {
    key: summary.key,
    project: summary.project,
    state: summary.state,
    priority: summary.priority,
    received_at: summary.received_at,
    detail: "",
  };
  if (summary.bail_expires_at !== undefined) {
    row.bail_expires_at = summary.bail_expires_at;
  }
  return row;
}

function rowOf(aggregate: TicketAggregate): BoardTicket {
  const row: BoardTicket = {
    key: aggregate.intention.key,
    project: aggregate.intention.project,
    state: aggregate.state,
    priority: aggregate.intention.priority,
    received_at: aggregate.received_at,
    attempts_used: aggregate.attempts_used,
    detail: detailOf(aggregate),
  };
  if (aggregate.intention.title !== undefined) {
    row.title = aggregate.intention.title;
  }
  if (aggregate.intention.featureTest === true) {
    row.feature_test = true;
  }
  if (aggregate.bail !== undefined) {
    row.bail_expires_at = aggregate.bail.expires_at;
  }
  if (aggregate.escalation !== undefined) {
    row.escalation = { kind: aggregate.escalation.kind };
  }
  if (aggregate.invalid !== undefined) {
    row.invalid = { code: aggregate.invalid.code, reason: aggregate.invalid.reason };
  }
  if (aggregate.submission !== undefined) {
    row.submission = {
      reference: aggregate.submission.reference,
      refusals: aggregate.submission.refusals,
    };
    if (aggregate.submission.last_report !== undefined) {
      row.submission.last_report = aggregate.submission.last_report;
    }
  }
  if (aggregate.parked_refusal !== undefined) {
    row.parked_refusal = { report: aggregate.parked_refusal.report };
    if (aggregate.parked_refusal.refused_by !== undefined) {
      row.parked_refusal.refused_by = aggregate.parked_refusal.refused_by;
    }
  }
  return row;
}

export function jsonOf(board: Board): unknown {
  return {
    features: board.features.map(({ detail: _, tickets, ...feature }) => ({
      ...feature,
      tickets: tickets.map(({ detail: __, ...ticket }) => ticket),
    })),
    tickets: board.tickets.map(({ detail: _, ...ticket }) => ticket),
  };
}

const TITLE_WIDTH = 40;

/** The tree: a header with the counts, each Feature with its Tickets under it, then the Tickets of none. Plain text, no colour. */
export function textOf(board: Board): string[] {
  const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;
  const ticketCount =
    board.tickets.length + board.features.reduce((sum, f) => sum + f.tickets.length, 0);
  const keyWidth = Math.max(
    0,
    ...board.features.flatMap((f) => [f.key.length - TREE_INDENT, ...f.tickets.map(keyLength)]),
    ...board.tickets.map(keyLength),
  );
  const titles = [
    ...board.features,
    ...board.features.flatMap((f) => f.tickets),
    ...board.tickets,
  ].map((row) => cell(row));
  const titleWidth = Math.min(TITLE_WIDTH, Math.max(0, ...titles.map((t) => t.length)));
  const render = (lead: string, row: BoardFeature | BoardTicket): string =>
    `${lead}${row.key}`.padEnd(TREE_INDENT + keyWidth) +
    `  ${row.state.padEnd(STATE_WIDTH)}  ${clip(cell(row), titleWidth).padEnd(titleWidth)}  ${row.detail}`.trimEnd();
  const lines = [`${count(board.features.length, "Feature")}, ${count(ticketCount, "Ticket")}`];
  const branch = (rows: BoardTicket[]): void => {
    rows.forEach((row, index) => {
      lines.push(render(index === rows.length - 1 ? "└── " : "├── ", row));
    });
  };
  for (const feature of board.features) {
    lines.push("", render("", feature));
    branch(feature.tickets);
  }
  if (board.tickets.length > 0) {
    lines.push("", "No Feature");
    branch(board.tickets);
  }
  return lines;
}

const TREE_INDENT = 4;
const STATE_WIDTH = 11;

function keyLength(row: { key: string }): number {
  return row.key.length;
}

/** The marker of a feature-test Ticket, then the title. */
function cell(row: BoardFeature | BoardTicket): string {
  const marker = "feature_test" in row && row.feature_test === true ? "[feature-test] " : "";
  return `${marker}${row.title ?? ""}`.trimEnd();
}

function clip(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}
