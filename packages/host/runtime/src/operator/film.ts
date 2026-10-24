/**
 * How `mason log` reads a journal line.
 *
 * `run` and `watch` do not use this. Their stdout stays the phase label.
 */

const WHY_LIMIT = 500;

export function formatJournalLine(line: Record<string, unknown>): string {
  const at = typeof line.at === "string" && line.at.length >= 19 ? line.at.slice(11, 19) : "";
  const event = typeof line.event === "string" ? line.event : "event";
  const key = typeof line.key === "string" ? line.key : "";
  return [at, event, key, headlineOf(line), whyOf(line)]
    .filter((part) => part.length > 0)
    .join("  ");
}

/**
 * Idle polls. A listen that brought nothing is the same noise — unless it did
 * not complete: a run that cannot see its tracker repeats that line and nothing
 * else, and hiding it is how half an hour goes into finding out why.
 */
export function isQuietJournalLine(line: Record<string, unknown>): boolean {
  if (line.event === "idle") {
    return true;
  }
  return line.event === "listen" && line.deliveries === 0 && line.outcome === "completed";
}

/**
 * A line that explains a stop: a Gate refused, a producer failed, a run came
 * back refused.
 */
export function isProblemJournalLine(line: Record<string, unknown>): boolean {
  if (line.event === "result") {
    return line.outcome !== "converted";
  }
  if (line.event === "ran") {
    return line.outcome === "refused" || line.outcome === "paused";
  }
  if (line.event === "describe-skipped") {
    return true;
  }
  if (line.event === "gate-finished") {
    return line.verdict !== "pass";
  }
  if (line.event === "builder-finished") {
    return builderFailed(line);
  }
  return textOf(line.detail) !== undefined || textOf(line.reason) !== undefined;
}

/** Distinct stops in the film, counted by what they say. */
export function tallyProblems(lines: Record<string, unknown>[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const line of lines) {
    if (line.event === "ran" || !isProblemJournalLine(line)) {
      continue;
    }
    const label = fallbackLabel(line);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts];
}

function fallbackLabel(line: Record<string, unknown>): string {
  if (line.event === "result" && typeof line.outcome === "string") {
    const why = textOf(line.detail) ?? textOf(line.reason);
    return why === undefined ? line.outcome : `${line.outcome}  ${clip(why)}`;
  }
  return formatJournalLine(line);
}

function builderFailed(line: Record<string, unknown>): boolean {
  const result = line.result;
  if (result === null || typeof result !== "object") {
    return false;
  }
  const kind = (result as { kind?: unknown }).kind;
  return typeof kind === "string" && kind !== "completed" && kind !== "skipped";
}

function headlineOf(line: Record<string, unknown>): string {
  if (typeof line.label === "string") {
    return line.label;
  }
  if (typeof line.outcome === "string") {
    return line.outcome;
  }
  if (typeof line.kind === "string") {
    return line.kind;
  }
  if (typeof line.phase === "string") {
    return line.phase;
  }
  // A held Ticket names when the bail frees it — that is the line a watcher
  // needs, not the state word alone.
  if (line.event === "held" && typeof line.until === "number") {
    return `until ${new Date(line.until).toISOString().slice(11, 19)}`;
  }
  if (typeof line.state === "string") {
    return line.state;
  }
  if (typeof line.reference === "string") {
    return line.reference;
  }
  if (typeof line.behind === "string") {
    return line.behind;
  }
  if (typeof line.deliveries === "number") {
    return String(line.deliveries);
  }
  return "";
}

function whyOf(line: Record<string, unknown>): string {
  const bits: string[] = [];
  if (typeof line.exitCode === "number") {
    bits.push(`exit ${line.exitCode}`);
  }
  const why = textOf(line.detail) ?? textOf(line.reason) ?? textOf(line.report);
  if (why !== undefined && why !== headlineOf(line)) {
    bits.push(clip(why));
  }
  return bits.join("  ");
}

function textOf(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > 0 ? flat : undefined;
}

function clip(text: string): string {
  if (text.length <= WHY_LIMIT) {
    return text;
  }
  return `…${text.slice(-(WHY_LIMIT - 1))}`;
}
