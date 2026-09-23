import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { PRODUCT } from "@bluewombat/manager-kit";
import { parseArgs } from "../config/parse-args.js";
import type { HostInvocation } from "../config/types.js";
import { journalPath, parseJournalChunk } from "../loop/journal.js";
import {
  formatJournalLine,
  isProblemJournalLine,
  isQuietJournalLine,
  tallyProblems,
} from "./film.js";

export type LogInput = {
  cwd: string;
  argv: string[];
  write: (line: string) => void;
};

type LogFlags = {
  json: boolean;
  all: boolean;
  problems: boolean;
  /** 0 means no limit. Ignored for JSON unless the operator passed `--tail`. */
  tail: number;
  tailExplicit: boolean;
  rest: string[];
  error?: string;
};

const DEFAULT_TAIL = 80;

/**
 * Replay the journal a run already wrote, with the reasons the live trace drops.
 *
 * Does not open Host, a manager, or Conductor. `watch` follows new lines from
 * the end; this reads the film that is already there.
 */
export async function runLog(input: LogInput): Promise<number> {
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
  const path = journalPath(parsed.invocation.ledgerRoot);
  if (!existsSync(path)) {
    input.write(`No journal at ${path}.\n`);
    input.write(`${PRODUCT} run has not written one yet.\n`);
    return 0;
  }
  let body: string;
  try {
    body = readFileSync(path, "utf8");
  } catch (error) {
    input.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const parsedLines = parseJournalChunk(body.endsWith("\n") ? body : `${body}\n`, "").lines;
  const kept = parsedLines.filter((line) => keepLine(line, flags));
  const limit = flags.json && !flags.tailExplicit ? 0 : flags.tail;
  const shown = limit > 0 && kept.length > limit ? kept.slice(-limit) : kept;

  if (flags.json) {
    const payload =
      flags.tailExplicit && shown.length < kept.length
        ? { kept: kept.length, shown: shown.length, lines: shown }
        : shown;
    input.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }

  input.write(`journal  ${path}\n`);
  if (shown.length < kept.length) {
    input.write(
      `showing last ${shown.length} of ${kept.length}  (${PRODUCT} log --tail 0 shows every kept line)\n`,
    );
  } else if (!flags.problems && kept.length < parsedLines.length) {
    input.write(`${kept.length} lines  (${parsedLines.length - kept.length} quiet lines hidden)\n`);
  } else {
    input.write(`${kept.length} lines\n`);
  }
  if (shown.length === 0) {
    input.write("Nothing to show.\n");
  } else {
    for (const line of shown) {
      input.write(`${formatJournalLine(line)}\n`);
    }
  }
  writeProblems(input.write, parsedLines);
  writeTranscripts(input.write, parsed.invocation);
  return 0;
}

function keepLine(line: Record<string, unknown>, flags: LogFlags): boolean {
  if (flags.problems) {
    return isProblemJournalLine(line);
  }
  if (flags.all) {
    return true;
  }
  return !isQuietJournalLine(line);
}

function writeProblems(write: (line: string) => void, kept: Record<string, unknown>[]): void {
  const counts = tallyProblems(kept);
  write("problems\n");
  if (counts.length === 0) {
    write("  none\n");
    return;
  }
  for (const [label, count] of counts) {
    write(count > 1 ? `  ${label}  ×${count}\n` : `  ${label}\n`);
  }
}

function writeTranscripts(write: (line: string) => void, invocation: HostInvocation): void {
  const dir = transcriptDir(invocation);
  if (dir === undefined) {
    return;
  }
  const files = newestTranscripts(dir, 5);
  write(`transcripts  ${dir}\n`);
  if (files.length === 0) {
    write("  (empty)\n");
    return;
  }
  for (const file of files) {
    const bits = [file.name, file.exit, file.duration].filter((part) => part.length > 0);
    write(`  ${bits.join("  ")}\n`);
    write(`    ${file.path}\n`);
  }
}

function transcriptDir(invocation: HostInvocation): string | undefined {
  const commands = [
    invocation.planner.cmd,
    invocation.builder.producer.cmd,
    invocation.builder.repair.cmd,
    ...(invocation.assembly.fix === undefined ? [] : [invocation.assembly.fix.cmd]),
  ];
  for (const cmd of commands) {
    const index = cmd.indexOf("--transcript-dir");
    const value = index >= 0 ? cmd[index + 1] : undefined;
    if (value !== undefined && value.length > 0) {
      return resolve(invocation.configDir, value);
    }
  }
  const fallback = join(invocation.home, "transcripts");
  return existsSync(fallback) ? fallback : undefined;
}

function newestTranscripts(
  dir: string,
  limit: number,
): { name: string; path: string; exit: string; duration: string }[] {
  const found: { path: string; mtimeMs: number }[] = [];
  collectTranscripts(dir, found);
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found.slice(0, limit).map((file) => {
    const heading = transcriptHeading(file.path);
    return {
      name: file.path.slice(dir.length + 1),
      path: file.path,
      exit: heading.exit,
      duration: heading.duration,
    };
  });
}

function collectTranscripts(dir: string, found: { path: string; mtimeMs: number }[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const path = join(dir, name);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      collectTranscripts(path, found);
      continue;
    }
    if (name.endsWith(".md")) {
      found.push({ path, mtimeMs: stat.mtimeMs });
    }
  }
}

function transcriptHeading(path: string): { exit: string; duration: string } {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(1500);
    const read = readSync(fd, buf, 0, buf.length, 0);
    const head = buf.toString("utf8", 0, read);
    return {
      exit: headingField(head, "exit"),
      duration: headingField(head, "duration"),
    };
  } catch {
    return { exit: "", duration: "" };
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

function headingField(head: string, name: string): string {
  const match = head.match(new RegExp(`^- ${name}: (.+)$`, "m"));
  if (match === null || match[1] === undefined) {
    return "";
  }
  return `${name} ${match[1].trim()}`;
}

function peelFlags(argv: string[]): LogFlags {
  const rest: string[] = [];
  let json = false;
  let all = false;
  let problems = false;
  let tail = DEFAULT_TAIL;
  let tailExplicit = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--all") {
      all = true;
      continue;
    }
    if (token === "--problems") {
      problems = true;
      continue;
    }
    if (token === "--tail") {
      const raw = argv[i + 1];
      if (raw === undefined || !/^\d+$/.test(raw)) {
        return {
          json,
          all,
          problems,
          tail,
          tailExplicit,
          rest,
          error: "--tail needs a number (0 shows every kept line).",
        };
      }
      tail = Number(raw);
      tailExplicit = true;
      i += 1;
      continue;
    }
    rest.push(token ?? "");
  }
  return { json, all, problems, tail, tailExplicit, rest };
}
