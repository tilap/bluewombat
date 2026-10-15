import type { TicketAggregate, TicketSummary, WorkLedger } from "@bluewombat/work-ledger";
import { describeTicket } from "../loop/trace.js";

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
  line: string;
};

export async function boardOf(ledger: WorkLedger): Promise<BoardTicket[]> {
  const summaries = await ledger.list();
  const rows: BoardTicket[] = [];
  for (const summary of summaries) {
    const got = await ledger.get(summary.key);
    rows.push(got.ok ? rowOf(got.aggregate) : rowFromSummary(summary));
  }
  return rows;
}

function rowFromSummary(summary: TicketSummary): BoardTicket {
  const row: BoardTicket = {
    key: summary.key,
    project: summary.project,
    state: summary.state,
    priority: summary.priority,
    received_at: summary.received_at,
    line: `${summary.key}  ${summary.state}`,
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
    line: describeTicket(aggregate),
  };
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

export function jsonOf(rows: BoardTicket[]): unknown {
  return rows.map(({ line, ...rest }) => rest);
}
