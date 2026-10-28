import type { TicketAggregate } from "@bluewombat/work-ledger";

/**
 * What the run says about itself while it works.
 *
 * A run can wait minutes on an Attempt and longer on a verdict. With nothing on
 * stdout there is no way to tell working from wedged, and no way to see which
 * stage a ticket is at without reading the WorkLedger by hand.
 *
 * One line per thing that happened, and one per pass over a ticket that is
 * waiting — a repeated line is how a reader knows the loop is still turning.
 */
export type Trace = (line: string) => void;

export function openTrace(write: (text: string) => void): Trace {
  return (line: string) => {
    write(`${stamp()} ${line}\n`);
  };
}

/** Where this ticket stands, in one line. */
export function describeTicket(aggregate: TicketAggregate): string {
  const key = aggregate.intention.key;
  const state = aggregate.state;
  return `${key}  ${state.padEnd(11)} ${detailOf(aggregate)}`.trimEnd();
}

export function detailOf(aggregate: TicketAggregate): string {
  switch (aggregate.state) {
    case "submitted":
      return aggregate.submission === undefined
        ? ""
        : `${aggregate.submission.reference}${
            aggregate.submission.refusals > 0
              ? ` (sent back ${aggregate.submission.refusals}x)`
              : ""
          }`;
    case "done":
      return aggregate.submission?.reference ?? "";
    case "escalated":
      return `${aggregate.escalation?.kind ?? "?"} — waiting for a human`;
    case "running":
      return runningDetail(aggregate);
    case "integrating":
      return aggregate.parked_refusal === undefined
        ? "assembling"
        : "ticket.validate sent it back (repair on its way)";
    case "invalid":
      return aggregate.invalid?.reason ?? "";
    default:
      return "";
  }
}

function runningDetail(aggregate: TicketAggregate): string {
  return `attempt ${aggregate.attempts_used}`;
}

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}

const FAILURE_KEEP = 240;

/**
 * What a failure line adds under its phase label.
 *
 * A clean pass says nothing extra. A stop carries the child's last words:
 * `detail`, `reason`, a non-zero exit, or a Gate report that did not pass.
 */
export function failureNote(line: Record<string, unknown>): string {
  const bits: string[] = [];
  if (typeof line.exitCode === "number" && line.exitCode !== 0) {
    bits.push(`exit ${line.exitCode}`);
  }
  const why = textOf(line.detail) ?? textOf(line.reason) ?? gateReport(line);
  if (why !== undefined) {
    bits.push(endOf(why));
  }
  return bits.join("  ");
}

function gateReport(line: Record<string, unknown>): string | undefined {
  if (line.event !== "gate-finished" || line.verdict === "pass" || line.verdict === undefined) {
    return undefined;
  }
  return textOf(line.report);
}

function textOf(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > 0 ? flat : undefined;
}

function endOf(text: string): string {
  if (text.length <= FAILURE_KEEP) {
    return text;
  }
  return `…${text.slice(-(FAILURE_KEEP - 1))}`;
}
