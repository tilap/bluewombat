import type { Trace } from "../types.js";

/** What the history may weigh, whatever the Task has been through. */
const BUDGET = 6_000;
/** What one report or one answer may weigh inside it. */
const REPORT_CLIP = 1_500;
const SAID_CLIP = 800;

// biome-ignore lint/suspicious/noControlCharactersInRegex: strips terminal colour codes
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

function clip(text: string, max: number): string {
  const clean = text.replace(ANSI, "").replace(/\r/g, "").trim();
  return clean.length > max ? `${clean.slice(0, max).trimEnd()}…` : clean;
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? `   ${line}` : line))
    .join("\n");
}

/** What the first Attempt was handed, when it was handed a refusal. */
function givenEntry(report: string, refusedBy: string | undefined): string {
  const who = refusedBy !== undefined && refusedBy.length > 0 ? refusedBy : "an outside judge";
  return `Refused by ${who}, before this Task's first attempt:\n${indent(clip(report, REPORT_CLIP))}`;
}

function attemptEntry(trace: Trace): string {
  const { builder, gates } = trace;
  const lines: string[] = [];
  const result = builder.result;
  const head = `Attempt ${trace.attempt} — `;
  switch (result.kind) {
    case "completed":
      lines.push(`${head}the producer finished.`);
      if (result.said !== undefined) {
        lines.push(indent(`It said: ${clip(result.said, SAID_CLIP)}`));
      }
      break;
    case "timed_out": {
      // The tail of what a killed child wrote is noise here; the film of the run keeps it.
      const ms = /^killed after (\d+)ms/.exec(result.detail ?? "");
      lines.push(
        `${head}the producer was killed at its time limit${ms === null ? "" : ` (${ms[1]}ms)`}, and left no answer.`,
      );
      break;
    }
    case "failed":
      lines.push(
        `${head}the producer failed (${result.outcome ?? "fail-retryable"}):\n${indent(clip(result.detail ?? "", SAID_CLIP))}`,
      );
      break;
    case "refused":
      lines.push(
        `${head}the producer could not be started:\n${indent(clip(result.detail ?? "", SAID_CLIP))}`,
      );
      break;
    case "skipped":
      lines.push(`${head}judged without a producer.`);
      break;
    case "interrupted":
      lines.push(`${head}stopped by a signal.`);
      break;
  }
  for (const gate of gates) {
    lines.push(
      gate.verdict === "pass"
        ? `   Gate ${gate.id}: pass.`
        : `   Gate ${gate.id}: ${gate.verdict}\n${indent(indent(clip(gate.report, REPORT_CLIP)))}`,
    );
  }
  return lines.join("\n");
}

/**
 * Everything the Task went through before the next Attempt, oldest first: the
 * refusal it started with, then each Attempt — how its producer ended, what it
 * said, what each Gate answered.
 *
 * The report an Attempt receives is only the latest of it, and the latest can
 * be a producer killed at its clock, which says nothing of why the Task is
 * here. This is what puts the original refusal back in front of the one who has
 * to act on it. Bounded: the refusal the Task came with always stays; when the
 * rest does not fit, the oldest Attempts are the ones left out.
 *
 * Absent while there is nothing to add to the report: a first Attempt, or a
 * Task that has not been through one yet.
 */
export function buildHistory(input: {
  report: string | undefined;
  refusedBy: string | undefined;
  traces: readonly Trace[];
}): string | undefined {
  const { report, refusedBy, traces } = input;
  if (traces.length === 0) {
    return undefined;
  }
  const given = report === undefined ? undefined : givenEntry(report, refusedBy);
  const attempts = traces.map(attemptEntry);

  let room = BUDGET - (given?.length ?? 0);
  const kept: string[] = [];
  for (let i = attempts.length - 1; i >= 0; i -= 1) {
    const entry = attempts[i] as string;
    if (entry.length > room && kept.length > 0) {
      break;
    }
    kept.unshift(entry);
    room -= entry.length;
  }
  const left = attempts.length - kept.length;

  const parts = [
    ...(given === undefined ? [] : [given]),
    ...(left > 0 ? [`(${left} earlier attempt${left === 1 ? "" : "s"} left out.)`] : []),
    ...kept,
  ];
  return `History of this Task, oldest first:\n\n${parts.join("\n\n")}`;
}
