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
 * A line that explains a stop: the Planner did not answer, a Gate refused,
 * a producer failed, a run came back refused.
 */
export function isProblemJournalLine(line: Record<string, unknown>): boolean {
  if (line.event === "result") {
    return line.outcome !== "planned" && line.outcome !== "converted";
  }
  if (line.event === "planner-finished") {
    return !(line.kind === "exited" && line.exitCode === 0);
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

/**
 * Distinct stops in the film.
 *
 * A `result` is counted with the exit of the `planner-finished` just before
 * it. A run that then pauses, with no exit code, is `interrupted`. It does
 * not share a bucket with a non-zero exit that left the same detail. `ran`
 * repeats the result, so it is not counted again. A `planner-finished` that
 * already has a `result` is not counted again either.
 */
export function tallyProblems(lines: Record<string, unknown>[]): [string, number][] {
  const counts = new Map<string, number>();
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line === undefined || line.event === "ran" || !isProblemJournalLine(line)) {
      continue;
    }
    if (
      line.event === "planner-finished" &&
      followingResult(lines, index, keyOf(line)) !== undefined
    ) {
      continue;
    }
    const label =
      line.event === "result" ? resultTallyLabel(line, lines, index) : fallbackLabel(line);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts];
}

function resultTallyLabel(
  line: Record<string, unknown>,
  lines: Record<string, unknown>[],
  index: number,
): string {
  const outcome = typeof line.outcome === "string" ? line.outcome : "result";
  const why = textOf(line.detail) ?? textOf(line.reason);
  const head = why === undefined ? outcome : `${outcome}  ${clip(why)}`;
  const prior = previousPlanner(lines, index, keyOf(line));
  if (prior !== undefined && typeof prior.exitCode === "number" && prior.exitCode !== 0) {
    return `${head}  exit ${prior.exitCode}`;
  }
  if (prior !== undefined && (prior.kind === "interrupted" || runPausedAfter(lines, index))) {
    return `interrupted  ${head}`;
  }
  return head;
}

function fallbackLabel(line: Record<string, unknown>): string {
  if (line.event === "planner-finished") {
    const kind = typeof line.kind === "string" ? line.kind : "finished";
    if (kind === "interrupted") {
      return "interrupted";
    }
    if (typeof line.exitCode === "number") {
      return `planner ${kind}  exit ${line.exitCode}`;
    }
    return `planner ${kind}`;
  }
  if (line.event === "result" && typeof line.outcome === "string") {
    const why = textOf(line.detail) ?? textOf(line.reason);
    return why === undefined ? line.outcome : `${line.outcome}  ${clip(why)}`;
  }
  return formatJournalLine(line);
}

function followingResult(
  lines: Record<string, unknown>[],
  index: number,
  key: string,
): Record<string, unknown> | undefined {
  for (let cursor = index + 1; cursor < lines.length; cursor++) {
    const line = lines[cursor];
    if (line === undefined) {
      continue;
    }
    if (line.event === "planner-finished" && keyOf(line) === key) {
      return undefined;
    }
    if (line.event === "result" && keyOf(line) === key) {
      return line;
    }
  }
  return undefined;
}

function previousPlanner(
  lines: Record<string, unknown>[],
  index: number,
  key: string,
): Record<string, unknown> | undefined {
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    const line = lines[cursor];
    if (line === undefined) {
      continue;
    }
    if (line.event === "planner-finished" && keyOf(line) === key) {
      return line;
    }
    if (line.event === "result" && keyOf(line) === key) {
      return undefined;
    }
  }
  return undefined;
}

/** The process stopped before another planner run. That is an interrupt, not another exit. */
function runPausedAfter(lines: Record<string, unknown>[], index: number): boolean {
  for (let cursor = index + 1; cursor < lines.length; cursor++) {
    const event = lines[cursor]?.event;
    if (event === "planner-finished" || event === "listen") {
      return false;
    }
    if (event === "paused") {
      return true;
    }
  }
  return false;
}

function builderFailed(line: Record<string, unknown>): boolean {
  const result = line.result;
  if (result === null || typeof result !== "object") {
    return false;
  }
  const kind = (result as { kind?: unknown }).kind;
  return typeof kind === "string" && kind !== "completed" && kind !== "skipped";
}

function keyOf(line: Record<string, unknown>): string {
  return typeof line.key === "string" ? line.key : "";
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
