import type { FeatureAggregate, FeatureSummary, WorkLedger } from "@bluewombat/work-ledger";
import { describeFeature } from "../loop/trace.js";

export type BoardFeature = {
  key: string;
  project: string;
  state: string;
  priority: number;
  received_at: number;
  bail_expires_at?: number;
  attempts_used?: number;
  subtasks?: { id: string; state: string }[];
  escalation?: { kind: string; subtask_id?: string };
  invalid?: { code: string; reason: string };
  submission?: { reference: string; refusals: number; last_report?: string };
  parked_refusal?: { report: string; refused_by?: string };
  line: string;
};

export async function boardOf(ledger: WorkLedger): Promise<BoardFeature[]> {
  const summaries = await ledger.list();
  const rows: BoardFeature[] = [];
  for (const summary of summaries) {
    const got = await ledger.get(summary.key);
    rows.push(got.ok ? rowOf(got.aggregate) : rowFromSummary(summary));
  }
  return rows;
}

function rowFromSummary(summary: FeatureSummary): BoardFeature {
  const row: BoardFeature = {
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

function rowOf(aggregate: FeatureAggregate): BoardFeature {
  const row: BoardFeature = {
    key: aggregate.intention.key,
    project: aggregate.intention.project,
    state: aggregate.state,
    priority: aggregate.intention.priority,
    received_at: aggregate.received_at,
    attempts_used: aggregate.attempts_used,
    line: describeFeature(aggregate),
  };
  if (aggregate.bail !== undefined) {
    row.bail_expires_at = aggregate.bail.expires_at;
  }
  if (aggregate.plan !== undefined) {
    row.subtasks = aggregate.plan.subtasks.map((subtask) => ({
      id: subtask.id,
      state: subtask.state,
    }));
  }
  if (aggregate.escalation !== undefined) {
    row.escalation = { kind: aggregate.escalation.kind };
    if (aggregate.escalation.subtask_id !== undefined) {
      row.escalation.subtask_id = aggregate.escalation.subtask_id;
    }
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

export function jsonOf(rows: BoardFeature[]): unknown {
  return rows.map(({ line, ...rest }) => rest);
}
