import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { openWorkLedger } from "@bluewombat/work-ledger";
import { parseArgs } from "../config/parse-args.js";
import { journalPath, parseJournalChunk } from "../loop/journal.js";
import { failureNote } from "../loop/trace.js";
import { openPersist } from "../plugins/persist.js";
import { boardOf, jsonOf } from "./board.js";

export type LiveInput = {
  cwd: string;
  argv: string[];
  write: (line: string) => void;
  interruptFlag: { interrupted: boolean };
  /** Watch follows; status does not. */
  follow: boolean;
  /** How often to look for new journal lines. Tests shrink this. */
  pollMs?: number;
};

/**
 * Snapshot the ledger, then optionally follow the journal.
 *
 * Does not open Host, a manager, or Conductor. The worker owns those.
 */
export async function runLive(input: LiveInput): Promise<number> {
  const peeled = peelJson(input.argv);
  const parsed = parseArgs(peeled.rest, { cwd: input.cwd, checkPaths: false });
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
    const rows = await boardOf(ledger);
    if (peeled.json) {
      input.write(`${JSON.stringify(jsonOf(rows), null, 2)}\n`);
    } else if (rows.length === 0) {
      input.write("No Features in the ledger.\n");
    } else {
      for (const row of rows) {
        input.write(`${row.line}\n`);
      }
    }
    if (!input.follow) {
      return 0;
    }
    return await followJournal({
      path: journalPath(parsed.invocation.ledgerRoot),
      write: input.write,
      interruptFlag: input.interruptFlag,
      pollMs: input.pollMs ?? 250,
    });
  } catch (error) {
    input.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

function peelJson(argv: string[]): { json: boolean; rest: string[] } {
  return {
    json: argv.includes("--json"),
    rest: argv.filter((token) => token !== "--json"),
  };
}

function formatFilm(line: Record<string, unknown>): string {
  const at = typeof line.at === "string" && line.at.length >= 19 ? line.at.slice(11, 19) : "";
  const event = typeof line.event === "string" ? line.event : "event";
  const key = typeof line.key === "string" ? line.key : "";
  const extra =
    typeof line.label === "string"
      ? line.label
      : typeof line.outcome === "string"
        ? String(line.outcome)
        : typeof line.state === "string"
          ? String(line.state)
          : typeof line.reference === "string"
            ? line.reference
            : typeof line.behind === "string"
              ? line.behind
              : "";
  const note = failureNote(line);
  return [at, event, key, extra, note].filter((part) => part.length > 0).join("  ");
}

async function followJournal(input: {
  path: string;
  write: (line: string) => void;
  interruptFlag: { interrupted: boolean };
  pollMs: number;
}): Promise<number> {
  let offset = 0;
  let remainder = "";
  let seen = existsSync(input.path);
  if (seen) {
    offset = sizeOf(input.path);
  } else {
    input.write("Worker has not written a journal yet.\n");
  }
  while (!input.interruptFlag.interrupted) {
    if (!existsSync(input.path)) {
      await sleep(input.pollMs, input.interruptFlag);
      continue;
    }
    if (!seen) {
      seen = true;
      offset = 0;
      remainder = "";
    }
    const read = readFrom(input.path, offset);
    offset = read.offset;
    if (read.chunk.length > 0) {
      const parsed = parseJournalChunk(read.chunk, remainder);
      remainder = parsed.remainder;
      for (const line of parsed.lines) {
        input.write(`${formatFilm(line)}\n`);
      }
    }
    await sleep(input.pollMs, input.interruptFlag);
  }
  return 0;
}

function sizeOf(path: string): number {
  const fd = openSync(path, "r");
  try {
    return fstatSync(fd).size;
  } finally {
    closeSync(fd);
  }
}

function readFrom(path: string, offset: number): { chunk: string; offset: number } {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (size < offset) {
      offset = 0;
    }
    if (size <= offset) {
      return { chunk: "", offset };
    }
    const buf = Buffer.alloc(size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    return { chunk: buf.toString("utf8"), offset: size };
  } finally {
    closeSync(fd);
  }
}

function sleep(ms: number, interruptFlag: { interrupted: boolean }): Promise<void> {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = (): void => {
      if (interruptFlag.interrupted || Date.now() - started >= ms) {
        resolve();
        return;
      }
      setTimeout(tick, Math.min(50, ms));
    };
    tick();
  });
}
