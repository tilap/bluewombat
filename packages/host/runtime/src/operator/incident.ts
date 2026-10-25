import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CLI_NAME } from "@bluewombat/manager-kit";
import {
  type FeatureAggregate,
  openWorkLedger,
  type TicketAggregate,
  type WorkLedger,
} from "@bluewombat/work-ledger";
import { parseArgs } from "../config/parse-args.js";
import type { HostInvocation } from "../config/types.js";
import { journalPath, parseJournalChunk } from "../loop/journal.js";
import { openPersist } from "../plugins/persist.js";
import { buildDossier, renderDossier } from "./incident-dossier.js";
import { transcriptDir } from "./log.js";

export type IncidentInput = {
  cwd: string;
  argv: string[];
  write: (text: string) => void;
  now?: () => Date;
};

type Flags = {
  json: boolean;
  out?: string;
  rest: string[];
  error?: string;
};

/**
 * Gather what is known about one stop into a single page, for whoever has to
 * understand it.
 *
 * Read-only: it opens the ledger, the journal and the files a run left, and
 * writes only where `--out` says. It does not open Host, a manager or
 * Conductor, so it works on a stopped run and on one still going. With no key
 * it lists what is waiting for a person.
 */
export async function runIncident(input: IncidentInput): Promise<number> {
  const first = input.argv[0];
  const wanted = first === undefined || first.startsWith("-") ? undefined : first;
  const flags = peelFlags(wanted === undefined ? input.argv : input.argv.slice(1));
  if (flags.error !== undefined) {
    input.write(`${flags.error}\n`);
    return 2;
  }
  const parsed = parseArgs(flags.rest, { cwd: input.cwd, checkPaths: false });
  if (!parsed.ok) {
    input.write(`${parsed.reason}\n`);
    return 2;
  }
  const invocation = parsed.invocation;
  try {
    const opened = await openPersist(
      invocation.persist,
      invocation.configDir,
      invocation.ledgerRoot,
    );
    if (!opened.ok) {
      input.write(`${opened.reason}\n`);
      return 2;
    }
    const ledger = openWorkLedger({ persist: opened.persist });
    if (wanted === undefined) {
      return await listWaiting(ledger, input.write);
    }
    const found = await resolveKey(ledger, wanted);
    if (!found.ok) {
      input.write(`${found.reason}\n`);
      return 2;
    }
    const subject = found.subject;
    const key = subject.intention.key;
    const gaps: string[] = [];
    const tickets = await ticketsOf(ledger, subject, gaps);
    const parent = await parentOf(ledger, subject);
    const dossier = buildDossier({
      subject,
      tickets,
      ...(parent === undefined ? {} : { parent }),
      journal: readJournal(invocation.ledgerRoot),
      invocation,
      streamsDir: invocation.observability?.streams?.dir ?? join(invocation.home, "streams"),
      ...transcriptsOf(invocation),
      now: (input.now ?? (() => new Date()))(),
    });
    dossier.gaps.push(...gaps);
    if (flags.out !== undefined) {
      const dir = resolve(input.cwd, flags.out);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "incident.json"), `${JSON.stringify(dossier, null, 2)}\n`);
      writeFileSync(join(dir, "incident.md"), renderDossier(dossier));
      input.write(
        `incident ${key}\n  ${join(dir, "incident.md")}\n  ${join(dir, "incident.json")}\n`,
      );
      return 0;
    }
    input.write(flags.json ? `${JSON.stringify(dossier, null, 2)}\n` : renderDossier(dossier));
    return 0;
  } catch (error) {
    input.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

async function listWaiting(ledger: WorkLedger, write: (text: string) => void): Promise<number> {
  const rows: string[] = [];
  for (const summary of await ledger.listFeatures()) {
    if (summary.state === "escalated") {
      const got = await ledger.getFeature(summary.key);
      rows.push(
        `${summary.key}  feature  ${firstLine(got.ok ? got.aggregate.escalation?.report : undefined)}`,
      );
    }
  }
  for (const summary of await ledger.list()) {
    if (summary.state === "escalated") {
      const got = await ledger.get(summary.key);
      rows.push(
        `${summary.key}  ticket  ${firstLine(got.ok ? got.aggregate.escalation?.report : undefined)}`,
      );
    }
  }
  if (rows.length === 0) {
    write("Nothing is waiting for a person.\n");
    return 0;
  }
  write(`Waiting for a person (${CLI_NAME} incident <key> gathers one):\n`);
  for (const row of rows) {
    write(`  ${row.trimEnd()}\n`);
  }
  return 0;
}

function firstLine(text: string | undefined): string {
  const line = (text ?? "").split("\n")[0] ?? "";
  return line.length > 100 ? `${line.slice(0, 100)}…` : line;
}

type Found =
  | { ok: true; subject: TicketAggregate | FeatureAggregate }
  | { ok: false; reason: string };

/** A full key, or the tracker's number: `106` and `#106` both find `github:acme/app#106`. */
async function resolveKey(ledger: WorkLedger, wanted: string): Promise<Found> {
  const keys = [
    ...(await ledger.listFeatures()).map((summary) => summary.key),
    ...(await ledger.list()).map((summary) => summary.key),
  ];
  const suffix = /^#?(\d+)$/.exec(wanted)?.[1];
  const matches = keys.filter(
    (key) => key === wanted || (suffix !== undefined && key.endsWith(`#${suffix}`)),
  );
  const exact = matches.find((key) => key === wanted);
  const chosen = exact ?? (matches.length === 1 ? matches[0] : undefined);
  if (chosen === undefined) {
    return {
      ok: false,
      reason:
        matches.length === 0
          ? `No Ticket or Feature matches ${wanted}. ${CLI_NAME} incident lists what is waiting.`
          : `${wanted} matches several keys: ${matches.join(", ")}`,
    };
  }
  const feature = await ledger.getFeature(chosen);
  if (feature.ok) {
    return { ok: true, subject: feature.aggregate };
  }
  const ticket = await ledger.get(chosen);
  return ticket.ok
    ? { ok: true, subject: ticket.aggregate }
    : { ok: false, reason: `${chosen} is gone.` };
}

async function ticketsOf(
  ledger: WorkLedger,
  subject: TicketAggregate | FeatureAggregate,
  gaps: string[],
): Promise<TicketAggregate[]> {
  const feature = "kind" in subject ? subject : await parentOf(ledger, subject);
  if (feature === undefined) {
    return [];
  }
  const found: TicketAggregate[] = [];
  for (const key of feature.tickets) {
    const got = await ledger.get(key);
    if (got.ok) {
      found.push(got.aggregate);
    } else {
      gaps.push(`Ticket ${key} of the feature is not in the ledger.`);
    }
  }
  return found;
}

async function parentOf(
  ledger: WorkLedger,
  subject: TicketAggregate | FeatureAggregate,
): Promise<FeatureAggregate | undefined> {
  if ("kind" in subject) {
    return undefined;
  }
  const key = subject.intention.feature;
  if (key === undefined) {
    return undefined;
  }
  const got = await ledger.getFeature(key);
  return got.ok ? got.aggregate : undefined;
}

function readJournal(ledgerRoot: string): Record<string, unknown>[] {
  const path = journalPath(ledgerRoot);
  if (!existsSync(path)) {
    return [];
  }
  const body = readFileSync(path, "utf8");
  return parseJournalChunk(body.endsWith("\n") ? body : `${body}\n`, "").lines;
}

function transcriptsOf(invocation: HostInvocation): { transcriptsDir?: string } {
  const dir = transcriptDir(invocation);
  return dir === undefined ? {} : { transcriptsDir: dir };
}

function peelFlags(argv: string[]): Flags {
  const rest: string[] = [];
  let json = false;
  let out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--out") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) {
        return { json, rest, error: "--out needs a directory." };
      }
      out = value;
      i += 1;
      continue;
    }
    rest.push(token ?? "");
  }
  return { json, rest, ...(out === undefined ? {} : { out }) };
}
