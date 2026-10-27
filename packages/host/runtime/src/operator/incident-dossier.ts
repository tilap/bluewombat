import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { FeatureAggregate, TicketAggregate } from "@bluewombat/work-ledger";
import type { HostInvocation } from "../config/types.js";
import { slug } from "../loop/streams.js";
import type { SystemFacts } from "./incident-system.js";

/**
 * What `mason incident` hands to whoever has to understand a stop.
 *
 * The WorkLedger says that something stopped and, in a sentence, why. The
 * journal says who answered what, in order. The streams and transcripts hold
 * what the checks and the agents said. Reading all of them to find one stop is
 * the work this does once, with no judgement: it never decides why the work
 * stopped, it puts the facts side by side and says which ones it could not find.
 */

export const INCIDENT_SCHEMA = "bluewombat.incident/1";

/** Longest text kept inline; the rest stays in the file it came from. */
const REPORT_LIMIT = 4000;
const EXCERPT_LIMIT = 3000;
const TAIL_BYTES = 64_000;

/** `none`: the subject is not stopped, and the page shows its last refusal if it had one. */
export type Layer = "unit" | "assembly" | "submitted" | "merging" | "feature" | "none" | "unknown";

export type TicketRow = {
  key: string;
  title?: string;
  state: string;
  attempts_used: number;
  reference?: string;
  featureTest?: boolean;
  blocked_by?: string[];
  done_at?: string;
  escalation?: { kind: string; report?: string };
};

export type TimelineRow = {
  at: string;
  event: string;
  task_id?: string;
  attempt?: number;
  gate_id?: string;
  verdict?: string;
  detail?: string;
};

export type StreamRow = {
  path: string;
  task_id?: string;
  gate_id?: string;
  attempt?: number;
  bytes?: number;
  exists: boolean;
  /** The end of what the stream said, for the check that refused. */
  excerpt?: string;
};

export type TranscriptRow = {
  path: string;
  title?: string;
  slot?: string;
  started?: string;
  ended?: string;
  duration?: string;
  exit?: string;
  /** `MASON_VERDICT:` or `MASON_BLOCKED:` line, when the agent ended on one. */
  marker?: string;
  /** The end of what the agent said. */
  final_message?: string;
};

export type GateConfigRow = {
  section: string;
  id: string;
  argv: string[];
  timeoutMs?: number;
  skipWhen?: string;
};

export type Dossier = {
  schema: typeof INCIDENT_SCHEMA;
  generated_at: string;
  subject: {
    key: string;
    kind: "ticket" | "feature";
    project: string;
    title?: string;
    state: string;
    source?: string;
    /** The first lines of what was asked. */
    intention: string;
    blocked_by?: string[];
  };
  stop: {
    layer: Layer;
    /** In the ledger's own words. */
    report?: string;
    /** What refused it: a Gate's id or a role, as the ledger or the journal named it. */
    refused_by?: string;
    at?: string;
    task_id?: string;
    attempt?: number;
    gate?: { id: string; verdict: string; report: string; at: string };
    agent?: { task_id: string; attempt?: number; failure: string; at: string };
    /** Where each field above came from, so a reader knows what to trust. */
    sources: string[];
  };
  history: {
    /** Earlier stops of this subject, then this one, in the journal. */
    escalations: number;
    resumes: number;
  };
  budgets: {
    attempts_used?: number;
    refusals?: number;
    parked_refusals?: number;
    realigns?: number;
  };
  parent?: { key: string; kind: "feature"; state: string; title?: string; tickets: TicketRow[] };
  tickets?: TicketRow[];
  gate_config?: GateConfigRow[];
  /** Versions, and what the configuration switched on. */
  system?: SystemFacts;
  timeline: TimelineRow[];
  artifacts: { streams: StreamRow[]; transcripts: TranscriptRow[] };
  /** What could not be found. A reader must not read an absence as a "no". */
  gaps: string[];
};

export type JournalLine = Record<string, unknown>;

export type DossierInput = {
  subject: TicketAggregate | FeatureAggregate;
  /** The Tickets of a Feature, or of the Feature a Ticket belongs to. */
  tickets: TicketAggregate[];
  parent?: FeatureAggregate;
  journal: JournalLine[];
  invocation?: HostInvocation;
  streamsDir?: string;
  transcriptsDir?: string;
  system?: SystemFacts;
  now: Date;
};

export function isFeature(
  subject: TicketAggregate | FeatureAggregate,
): subject is FeatureAggregate {
  return "kind" in subject && subject.kind === "feature";
}

export function buildDossier(input: DossierInput): Dossier {
  const gaps: string[] = [];
  const subject = input.subject;
  const key = subject.intention.key;
  const feature = isFeature(subject);
  const mine = linesOf(input.journal, key);
  const stopIndex = lastIndex(
    mine,
    (line) => line.event === "status" && line.phase === "escalated",
  );
  const previous =
    stopIndex < 0
      ? -1
      : lastIndex(
          mine.slice(0, stopIndex),
          (line) => line.event === "status" && line.phase === "escalated",
        );
  const escalations = mine.filter(
    (line) => line.event === "status" && line.phase === "escalated",
  ).length;
  const end = stopIndex < 0 ? mine.length : stopIndex + 1;
  const round = mine.slice(previous + 1, end);

  if (input.journal.length === 0) {
    gaps.push("No journal: who answered what, and when, is not known.");
  } else if (mine.length === 0) {
    gaps.push(`The journal holds no line for ${key}.`);
  } else if (stopIndex < 0) {
    gaps.push(
      "The journal has no line saying the work escalated; the moment comes from the ledger only.",
    );
  }

  const escalation = subject.escalation;
  const stopLine = stopIndex < 0 ? undefined : mine[stopIndex];
  const gate = failedGate(round);
  const agent = failedAgent(round);
  const sources: string[] = [];
  if (escalation !== undefined) {
    sources.push("ledger");
  } else if (subject.state === "escalated") {
    gaps.push("The ledger holds no escalation record for this subject.");
  } else {
    gaps.push(
      `The subject is ${subject.state}, not escalated: the stop shown is the last refusal.`,
    );
  }
  if (gate !== undefined || agent !== undefined || stopLine !== undefined) {
    sources.push("journal");
  }

  const report = clip(escalation?.report ?? subject.parked_refusal?.report, REPORT_LIMIT);
  const at = escalatedAt(escalation?.at, stopLine);
  const stop: Dossier["stop"] = { layer: layerOf(subject), sources };
  if (report !== undefined) {
    stop.report = report;
  }
  const refusedBy = refusedByOf(escalation, gate, report);
  if (refusedBy !== undefined) {
    stop.refused_by = refusedBy;
  }
  if (at !== undefined) {
    stop.at = at;
  }
  if (stopLine !== undefined) {
    setText(stop, "task_id", stopLine.task_id);
    setNumber(stop, "attempt", stopLine.attempt);
  }
  if (gate !== undefined) {
    stop.gate = {
      id: gate.gate_id,
      verdict: gate.verdict,
      report: clip(gate.report, REPORT_LIMIT) ?? "",
      at: gate.at,
    };
  }
  if (agent !== undefined) {
    stop.agent = agent;
  }

  const tickets = rowsOf(input.tickets, input.journal);
  const dossier: Dossier = {
    schema: INCIDENT_SCHEMA,
    generated_at: input.now.toISOString(),
    subject: {
      key,
      kind: feature ? "feature" : "ticket",
      project: subject.intention.project,
      state: subject.state,
      intention: head(subject.intention.intention, 12),
    },
    stop,
    history: { escalations, resumes: subject.resumes },
    budgets: budgetsOf(subject),
    timeline: round.map(timelineRow).filter((row): row is TimelineRow => row !== undefined),
    artifacts: { streams: [], transcripts: [] },
    gaps,
  };
  if (subject.intention.title !== undefined) {
    dossier.subject.title = subject.intention.title;
  }
  const source = subject.intention.source?.ref;
  if (source !== undefined) {
    dossier.subject.source = source;
  }
  const blockedBy = subject.intention.blocked_by;
  if (blockedBy !== undefined && blockedBy.length > 0) {
    dossier.subject.blocked_by = blockedBy;
  }
  if (feature) {
    dossier.tickets = tickets;
  } else if (input.parent !== undefined) {
    dossier.parent = {
      key: input.parent.intention.key,
      kind: "feature",
      state: input.parent.state,
      tickets,
      ...(input.parent.intention.title === undefined
        ? {}
        : { title: input.parent.intention.title }),
    };
  }
  if (input.invocation !== undefined && gate !== undefined) {
    const configured = gateConfigOf(input.invocation, gate.gate_id);
    if (configured.length > 0) {
      dossier.gate_config = configured;
    } else {
      gaps.push(`Gate ${gate.gate_id} is not in the current configuration.`);
    }
  }
  if (input.system !== undefined) {
    dossier.system = input.system;
  }
  collectStreams(dossier, round, input.streamsDir, gate, gaps);
  collectTranscripts(dossier, key, input.transcriptsDir, gaps);
  return dossier;
}

/** Lines that belong to a key: its own, and those of the Tasks filed under it. */
function linesOf(journal: JournalLine[], key: string): JournalLine[] {
  return journal.filter((line) => {
    if (line.key === key) {
      return true;
    }
    return (
      typeof line.task_id === "string" &&
      (line.task_id === key || line.task_id.startsWith(`${key}:`))
    );
  });
}

function lastIndex<T>(items: T[], test: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (test(items[i] as T)) {
      return i;
    }
  }
  return -1;
}

type GateLine = { gate_id: string; verdict: string; report: string; at: string; task_id?: string };

/** The last check that did not pass, before the stop. */
function failedGate(round: JournalLine[]): GateLine | undefined {
  const index = lastIndex(
    round,
    (line) =>
      line.event === "gate-finished" &&
      typeof line.gate_id === "string" &&
      typeof line.verdict === "string" &&
      line.verdict !== "pass",
  );
  const line = index < 0 ? undefined : round[index];
  if (line === undefined) {
    return undefined;
  }
  const found: GateLine = {
    gate_id: String(line.gate_id),
    verdict: String(line.verdict),
    report: typeof line.report === "string" ? line.report : "",
    at: typeof line.at === "string" ? line.at : "",
  };
  if (typeof line.task_id === "string") {
    found.task_id = line.task_id;
  }
  return found;
}

/** The last agent that did not complete, before the stop. */
function failedAgent(round: JournalLine[]): Dossier["stop"]["agent"] | undefined {
  const index = lastIndex(
    round,
    (line) => line.event === "builder-finished" && failureOf(line) !== undefined,
  );
  const line = index < 0 ? undefined : round[index];
  if (line === undefined || typeof line.task_id !== "string") {
    return undefined;
  }
  const agent: NonNullable<Dossier["stop"]["agent"]> = {
    task_id: line.task_id,
    failure: failureOf(line) ?? "",
    at: typeof line.at === "string" ? line.at : "",
  };
  if (typeof line.attempt === "number") {
    agent.attempt = line.attempt;
  }
  return agent;
}

function failureOf(line: JournalLine): string | undefined {
  const result = line.result;
  if (result === null || typeof result !== "object") {
    return undefined;
  }
  const kind = (result as { kind?: unknown }).kind;
  if (typeof kind !== "string" || kind === "completed" || kind === "skipped") {
    return undefined;
  }
  const reason = (result as { reason?: unknown }).reason;
  return typeof reason === "string" && reason.length > 0 ? `${kind}: ${clip(reason, 500)}` : kind;
}

function layerOf(subject: TicketAggregate | FeatureAggregate): Layer {
  if (subject.escalation === undefined) {
    return subject.state === "escalated" ? "unknown" : "none";
  }
  return isFeature(subject) ? "feature" : subject.escalation.kind;
}

function refusedByOf(
  escalation: { refused_by?: string } | undefined,
  gate: GateLine | undefined,
  report: string | undefined,
): string | undefined {
  if (escalation?.refused_by !== undefined) {
    return escalation.refused_by;
  }
  // An older record names nobody: take the check whose words the ledger repeats.
  if (gate !== undefined && gate.report.length > 0 && report?.includes(gate.report.slice(0, 80))) {
    return gate.gate_id;
  }
  return undefined;
}

function escalatedAt(
  ledgerAt: number | undefined,
  line: JournalLine | undefined,
): string | undefined {
  if (typeof line?.at === "string") {
    return line.at;
  }
  return ledgerAt === undefined ? undefined : new Date(ledgerAt).toISOString();
}

function budgetsOf(subject: TicketAggregate | FeatureAggregate): Dossier["budgets"] {
  const budgets: Dossier["budgets"] = {};
  if (!isFeature(subject)) {
    budgets.attempts_used = subject.attempts_used;
  }
  const submission = subject.submission;
  if (submission?.refusals !== undefined) {
    budgets.refusals = submission.refusals;
  }
  if (subject.parked_refusals !== undefined) {
    budgets.parked_refusals = subject.parked_refusals;
  }
  if (submission?.realigns !== undefined) {
    budgets.realigns = submission.realigns;
  }
  return budgets;
}

function rowsOf(tickets: TicketAggregate[], journal: JournalLine[]): TicketRow[] {
  return tickets.map((ticket) => {
    const intention = ticket.intention;
    const row: TicketRow = {
      key: intention.key,
      state: ticket.state,
      attempts_used: ticket.attempts_used,
    };
    if (intention.title !== undefined) {
      row.title = intention.title;
    }
    const reference = ticket.submission?.reference;
    if (reference !== undefined) {
      row.reference = reference;
    }
    if (intention.featureTest === true) {
      row.featureTest = true;
    }
    if (intention.blocked_by !== undefined && intention.blocked_by.length > 0) {
      row.blocked_by = intention.blocked_by;
    }
    const doneAt = journal.find(
      (line) => line.event === "reported" && line.reported === "done" && line.key === intention.key,
    )?.at;
    if (typeof doneAt === "string") {
      row.done_at = doneAt;
    }
    if (ticket.escalation !== undefined) {
      row.escalation = { kind: ticket.escalation.kind };
      if (ticket.escalation.report !== undefined) {
        row.escalation.report = clip(ticket.escalation.report, 500) ?? "";
      }
    }
    return row;
  });
}

const TIMELINE_EVENTS = new Set([
  "isolation-finished",
  "integration-finished",
  "attempt-finished",
  "builder-finished",
  "gate-finished",
  "submitted",
  "submit-refused",
  "invalid",
  "skipped",
  "run-finished",
]);

function timelineRow(line: JournalLine): TimelineRow | undefined {
  const event = typeof line.event === "string" ? line.event : undefined;
  if (event === undefined || typeof line.at !== "string") {
    return undefined;
  }
  // The phases of a status are said again by the event that ends them; only the stop is new.
  const stopStatus = event === "status" && line.phase === "escalated";
  if (!TIMELINE_EVENTS.has(event) && !stopStatus) {
    return undefined;
  }
  const row: TimelineRow = { at: line.at, event };
  setText(row, "task_id", line.task_id);
  setNumber(row, "attempt", line.attempt);
  setText(row, "gate_id", line.gate_id);
  setText(row, "verdict", line.verdict);
  const detail = detailOf(line);
  if (detail !== undefined) {
    row.detail = detail;
  }
  return row;
}

function detailOf(line: JournalLine): string | undefined {
  for (const name of ["report", "label", "outcome", "ended", "reason", "reference"]) {
    const value = line[name];
    if (typeof value === "string" && value.length > 0) {
      return clip(value, 300);
    }
  }
  return failureOf(line);
}

function gateConfigOf(invocation: HostInvocation, id: string): GateConfigRow[] {
  const found: GateConfigRow[] = [];
  const sections: [
    string,
    { id: string; argv: string[]; timeoutMs?: number; skipWhen?: string }[] | undefined,
  ][] = [
    ["builder.gates", invocation.builder.producer.gates],
    ["builder.repair.gates", invocation.builder.repair.gates],
    ["builder.featureTest.gates", invocation.builder.featureTest?.gates],
    ["ticket.fix.gates", invocation.ticket.fix?.gates],
    ["ticket.validate.gates", invocation.ticket.validate?.gates],
    ["feature.fix.gates", invocation.feature?.fix.gates],
    ["feature.validate.gates", invocation.feature?.validate.gates],
    ["feature.gates", invocation.feature?.gates],
  ];
  for (const [section, gates] of sections) {
    for (const gate of gates ?? []) {
      if (gate.id === id) {
        found.push({
          section,
          id,
          argv: gate.argv,
          ...(gate.timeoutMs === undefined ? {} : { timeoutMs: gate.timeoutMs }),
          ...(gate.skipWhen === undefined ? {} : { skipWhen: gate.skipWhen }),
        });
      }
    }
  }
  return found;
}

function collectStreams(
  dossier: Dossier,
  round: JournalLine[],
  streamsDir: string | undefined,
  gate: GateLine | undefined,
  gaps: string[],
): void {
  const opened = round.filter(
    (line) => line.event === "stream-opened" && typeof line.path === "string",
  );
  if (opened.length === 0) {
    gaps.push(
      "No stream recorded for this stop (streams are off unless the Project turns them on, or they were discarded).",
    );
    return;
  }
  const closed = new Map<string, JournalLine>();
  for (const line of round) {
    if (line.event === "stream-closed" && typeof line.path === "string") {
      closed.set(line.path, line);
    }
  }
  for (const line of opened) {
    const path = String(line.path);
    const absolute = streamsDir === undefined ? path : join(streamsDir, path);
    const exists = streamsDir !== undefined && existsSync(absolute);
    const row: StreamRow = { path: absolute, exists };
    setText(row, "task_id", line.task_id);
    setText(row, "gate_id", line.gate_id);
    setNumber(row, "attempt", line.attempt);
    setNumber(row, "bytes", closed.get(path)?.bytes);
    if (
      exists &&
      gate !== undefined &&
      line.gate_id === gate.gate_id &&
      line.task_id === gate.task_id
    ) {
      const text = streamText(absolute);
      if (text !== undefined) {
        row.excerpt = tail(text, EXCERPT_LIMIT);
      }
    }
    dossier.artifacts.streams.push(row);
  }
  if (streamsDir === undefined) {
    gaps.push("The streams directory is not known, so no stream file could be read.");
  } else if (dossier.artifacts.streams.every((row) => !row.exists)) {
    gaps.push("The streams recorded for this stop are no longer on disk.");
  }
}

/** The `text` of each chunk of a stream file (NDJSON), in order. */
function streamText(path: string): string | undefined {
  const raw = readTail(path);
  if (raw === undefined) {
    return undefined;
  }
  let text = "";
  for (const row of raw.split("\n")) {
    if (row.length === 0) {
      continue;
    }
    try {
      const chunk = (JSON.parse(row) as { text?: unknown }).text;
      text += typeof chunk === "string" ? chunk : "";
    } catch {
      // The first row of a tail can be cut in half.
    }
  }
  return text;
}

function collectTranscripts(
  dossier: Dossier,
  key: string,
  transcriptsDir: string | undefined,
  gaps: string[],
): void {
  if (transcriptsDir === undefined) {
    gaps.push("The transcripts directory is not known.");
    return;
  }
  const dir = join(transcriptsDir, slug(key));
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".md"));
  } catch {
    gaps.push(`No transcripts under ${dir}: the agents of this subject, if any, left none.`);
    return;
  }
  names.sort();
  for (const name of names) {
    dossier.artifacts.transcripts.push(transcriptRow(join(dir, name)));
  }
}

function transcriptRow(path: string): TranscriptRow {
  const row: TranscriptRow = { path };
  const head = readHead(path);
  if (head !== undefined) {
    const title = /^# (.+)$/m.exec(head)?.[1];
    if (title !== undefined) {
      row.title = title.trim();
    }
    for (const name of ["slot", "started", "ended", "duration", "exit"] as const) {
      const value = new RegExp(`^- ${name}: (.+)$`, "m").exec(head)?.[1];
      if (value !== undefined) {
        row[name] = value.trim();
      }
    }
  }
  const end = readTail(path);
  if (end !== undefined) {
    const marker = [...end.matchAll(/MASON_(?:VERDICT|BLOCKED):[^\n"\\]*/g)].pop()?.[0];
    if (marker !== undefined) {
      row.marker = marker.trim();
    }
    const message = finalMessage(end);
    if (message !== undefined) {
      row.final_message = tail(message, EXCERPT_LIMIT);
    }
  }
  return row;
}

/** The agent's closing words: the `result` of a stream-json run, or nothing. */
function finalMessage(text: string): string | undefined {
  for (const row of text.split("\n").reverse()) {
    if (!row.startsWith('{"type":"result"')) {
      continue;
    }
    try {
      const result = (JSON.parse(row) as { result?: unknown }).result;
      return typeof result === "string" ? result : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function readHead(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8").slice(0, 3000);
  } catch {
    return undefined;
  }
}

function readTail(path: string): string | undefined {
  try {
    const size = statSync(path).size;
    const text = readFileSync(path, "utf8");
    return size <= TAIL_BYTES ? text : text.slice(-TAIL_BYTES);
  } catch {
    return undefined;
  }
}

function setText(target: object, name: string, value: unknown): void {
  if (typeof value === "string" && value.length > 0) {
    (target as Record<string, unknown>)[name] = value;
  }
}

function setNumber(target: object, name: string, value: unknown): void {
  if (typeof value === "number") {
    (target as Record<string, unknown>)[name] = value;
  }
}

function clip(text: string | undefined, limit: number): string | undefined {
  if (text === undefined) {
    return undefined;
  }
  return text.length <= limit
    ? text
    : `${text.slice(0, limit)}… (${text.length - limit} more characters)`;
}

function tail(text: string, limit: number): string {
  return text.length <= limit ? text : `… ${text.slice(-limit)}`;
}

function head(text: string, lines: number): string {
  const all = text.split("\n");
  return all.length <= lines
    ? text
    : `${all.slice(0, lines).join("\n")}\n… (${all.length - lines} more lines)`;
}

/** The dossier as a page to read: the facts first, the detail after. */
export function renderDossier(dossier: Dossier): string {
  const out: string[] = [];
  const subject = dossier.subject;
  const stop = dossier.stop;
  out.push(`# Incident: ${subject.key}${subject.title === undefined ? "" : ` — ${subject.title}`}`);
  out.push("");
  out.push(
    `${subject.kind} · ${subject.state} · project ${subject.project} · generated ${dossier.generated_at}`,
  );
  if (subject.source !== undefined) {
    out.push(`source: ${subject.source}`);
  }
  out.push("");
  out.push("## The stop");
  out.push("");
  out.push(`- layer: ${stop.layer}`);
  if (stop.refused_by !== undefined) {
    out.push(`- refused by: ${stop.refused_by}`);
  }
  if (stop.gate !== undefined) {
    out.push(`- gate: ${stop.gate.id} → ${stop.gate.verdict} (${stop.gate.at})`);
  }
  if (stop.agent !== undefined) {
    out.push(`- agent: ${stop.agent.task_id} ended on ${stop.agent.failure}`);
  }
  if (stop.task_id !== undefined) {
    out.push(
      `- task: ${stop.task_id}${stop.attempt === undefined ? "" : `, attempt ${stop.attempt}`}`,
    );
  }
  if (stop.at !== undefined) {
    out.push(`- at: ${stop.at}`);
  }
  out.push(
    `- stops of this subject in the journal: ${dossier.history.escalations}; resumes: ${dossier.history.resumes}`,
  );
  const budgets = Object.entries(dossier.budgets).map(([name, value]) => `${name} ${value}`);
  if (budgets.length > 0) {
    out.push(`- budgets: ${budgets.join(", ")}`);
  }
  out.push(`- read from: ${stop.sources.join(", ") || "nothing"}`);
  if (stop.report !== undefined) {
    out.push("");
    out.push("What the ledger says, verbatim:");
    out.push("");
    out.push(fence(stop.report));
  }
  if (stop.gate !== undefined && stop.gate.report !== stop.report) {
    out.push("");
    out.push(`What gate ${stop.gate.id} said, verbatim:`);
    out.push("");
    out.push(fence(stop.gate.report));
  }
  out.push("");
  out.push("## What was asked");
  out.push("");
  out.push(fence(subject.intention));
  if (subject.blocked_by !== undefined) {
    out.push("");
    out.push(`blocked by: ${subject.blocked_by.join(", ")}`);
  }
  const rows = dossier.tickets ?? dossier.parent?.tickets;
  if (rows !== undefined && rows.length > 0) {
    out.push("");
    out.push(
      dossier.parent === undefined
        ? "## Tickets of this feature"
        : `## Tickets of ${dossier.parent.key} (${dossier.parent.state})`,
    );
    out.push("");
    for (const row of rows) {
      const bits = [row.state, `${row.attempts_used} attempt(s)`];
      if (row.reference !== undefined) {
        bits.push(row.reference);
      }
      if (row.done_at !== undefined) {
        bits.push(`done ${row.done_at}`);
      }
      if (row.featureTest === true) {
        bits.push("feature-test");
      }
      out.push(
        `- ${row.key}${row.title === undefined ? "" : ` ${row.title}`} — ${bits.join(", ")}`,
      );
    }
  }
  if (dossier.gate_config !== undefined) {
    out.push("");
    out.push("## Configuration of the gate");
    out.push("");
    for (const gate of dossier.gate_config) {
      out.push(
        `- ${gate.section}: \`${gate.argv.join(" ")}\`${gate.timeoutMs === undefined ? "" : ` (timeout ${gate.timeoutMs} ms)`}${gate.skipWhen === undefined ? "" : ` skipWhen ${gate.skipWhen}`}`,
      );
    }
  }
  if (dossier.system !== undefined) {
    out.push(...renderSystem(dossier.system));
  }
  if (dossier.timeline.length > 0) {
    out.push("");
    out.push("## Timeline of the last round");
    out.push("");
    for (const row of dossier.timeline) {
      const who = row.gate_id ?? row.task_id ?? "";
      const verdict = row.verdict === undefined ? "" : ` ${row.verdict}`;
      const detail = row.detail === undefined ? "" : `  ${row.detail.replace(/\s+/g, " ")}`;
      out.push(`- ${row.at.slice(11, 23)} ${row.event} ${who}${verdict}${detail}`.trimEnd());
    }
  }
  const { streams, transcripts } = dossier.artifacts;
  if (streams.length > 0 || transcripts.length > 0) {
    out.push("");
    out.push("## Files");
    out.push("");
    for (const stream of streams) {
      out.push(`- stream${stream.exists ? "" : " (gone)"}: ${stream.path}`);
    }
    for (const transcript of transcripts) {
      const bits = [
        transcript.exit === undefined ? undefined : `exit ${transcript.exit}`,
        transcript.duration,
        transcript.marker,
      ].filter((bit): bit is string => bit !== undefined);
      out.push(
        `- transcript: ${transcript.path}${bits.length === 0 ? "" : `  (${bits.join(", ")})`}`,
      );
    }
  }
  for (const stream of streams) {
    if (stream.excerpt !== undefined) {
      out.push("");
      out.push(`## What ${stream.gate_id ?? "the check"} printed (end of its stream)`);
      out.push("");
      out.push(fence(stream.excerpt));
    }
  }
  if (dossier.gaps.length > 0) {
    out.push("");
    out.push("## Not found");
    out.push("");
    for (const gap of dossier.gaps) {
      out.push(`- ${gap}`);
    }
  }
  out.push("");
  return out.join("\n");
}

function renderSystem(system: SystemFacts): string[] {
  const { bluewombat, config } = system;
  const out = ["", "## The system", ""];
  out.push(`- bluewombat ${bluewombat.host}, node ${bluewombat.node}, ${bluewombat.platform}`);
  if (system.packages.length > 0) {
    out.push(
      `- installed: ${system.packages.map((pkg) => `${pkg.name.replace("@bluewombat/", "")} ${pkg.version}`).join(", ")}`,
    );
  }
  out.push(`- trackers: features ${config.featureTracker}, tickets ${config.ticketTracker}`);
  out.push(`- ledger: ${config.persist}; work line isolation: ${config.isolation}`);
  out.push(
    `- authority: ${config.authority}; tickets in parallel: ${config.maxParallel}; streams: ${config.streams}`,
  );
  const limits = Object.entries(config.limits).map(([name, value]) => `${name} ${value}`);
  if (limits.length > 0) {
    out.push(`- limits: ${limits.join(", ")}`);
  }
  out.push(
    `- passes: ${Object.entries(config.reviews)
      .map(([name, value]) => `${name} ${value}`)
      .join("; ")}`,
  );
  if (Object.keys(config.agents).length > 0) {
    out.push(
      `- agents: ${Object.entries(config.agents)
        .map(([role, program]) => `${role} ${program}`)
        .join("; ")}`,
    );
  }
  for (const [name, ids] of Object.entries(config.gates)) {
    out.push(`- ${name}: ${ids.join(", ")}`);
  }
  out.push(`- config: ${config.path ?? config.dir}`);
  if (config.raw !== undefined) {
    out.push(
      "",
      "The configuration file, values of secret-looking keys blanked:",
      "",
      fence(config.raw),
    );
  }
  return out;
}

function fence(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const mark = "`".repeat(Math.max(3, longest + 1));
  return `${mark}text\n${text}\n${mark}`;
}
