export const UNBLOCK_KINDS = [
  "resume",
  "restart",
  "cancel",
  "start-worker",
  "restart-worker",
  "cleanup-disk",
] as const;
export type UnblockKind = (typeof UNBLOCK_KINDS)[number];

/** What puts the run back in motion, now or once the fixes have landed. */
export type Unblock = { do: UnblockKind; key?: string; reason: string };

/** A change to a repository the supervisor was given, so that this does not happen again. */
export type Fix = {
  target: string;
  title: string;
  /** The result to reach and what proves it, inside the rules. Not the design: the fixer designs. */
  instruction: string;
  /** The rules and accepted decisions the change touches, and why it conforms to each. */
  conformity: string;
  /**
   * Set when no change can reach the result without revisiting an accepted decision or rule: which one.
   * Such a fix is not made; a person decides.
   */
  revises?: string;
};

export type Decision = {
  summary: string;
  cause: string;
  /** `file:line`, a log line, a command and what it printed. Nothing that was not seen. */
  evidence: string[];
  confidence: "high" | "medium" | "low";
  /** The unblock needs the fixes first (the same stop would come straight back). */
  unblockAfterFixes: boolean;
  unblock: Unblock[];
  fixes: Fix[];
  /** Set when no one but a person can go on: what only they can decide. */
  needsHuman?: string;
};

export type Parsed = { ok: true; decision: Decision } | { ok: false; reason: string };

const NEEDS_KEY: readonly UnblockKind[] = ["resume", "restart", "cancel"];

/** The last JSON object an agent printed: in a ```json fence, else the last balanced braces. */
export function lastJson(output: string): unknown {
  const fenced = [...output.matchAll(/```json\s*([\s\S]*?)```/g)].map((m) => m[1] ?? "");
  for (const body of fenced.reverse()) {
    const value = tryParse(body);
    if (value !== undefined) {
      return value;
    }
  }
  for (let end = output.lastIndexOf("}"); end >= 0; end = output.lastIndexOf("}", end - 1)) {
    for (
      let start = output.lastIndexOf("{", end);
      start >= 0;
      start = output.lastIndexOf("{", start - 1)
    ) {
      const value = tryParse(output.slice(start, end + 1));
      if (value !== undefined) {
        return value;
      }
    }
  }
  return undefined;
}

function tryParse(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

export function parseDecision(output: string, targets: readonly string[]): Parsed {
  const value = lastJson(output);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "no JSON object in the arbiter's answer" };
  }
  const o = value as Record<string, unknown>;
  const problems: string[] = [];
  const str = (name: string): string => {
    const v = o[name];
    if (typeof v !== "string" || v.trim().length === 0) {
      problems.push(`${name} must be a non-empty string`);
      return "";
    }
    return v;
  };
  const summary = str("summary");
  const cause = str("cause");
  const evidence = Array.isArray(o.evidence) ? o.evidence.map(String) : [];
  if (evidence.length === 0) {
    problems.push("evidence must name what was seen");
  }
  const confidence = o.confidence;
  if (confidence !== "high" && confidence !== "medium" && confidence !== "low") {
    problems.push("confidence must be high, medium or low");
  }
  const unblock: Unblock[] = [];
  for (const raw of Array.isArray(o.unblock) ? o.unblock : []) {
    const u = (raw ?? {}) as Record<string, unknown>;
    const kind = UNBLOCK_KINDS.find((k) => k === u.do);
    if (kind === undefined) {
      problems.push(`unblock.do ${JSON.stringify(u.do)} is not one of ${UNBLOCK_KINDS.join(", ")}`);
      continue;
    }
    if (NEEDS_KEY.includes(kind) && typeof u.key !== "string") {
      problems.push(`unblock ${kind} needs a key`);
      continue;
    }
    unblock.push({
      do: kind,
      ...(typeof u.key === "string" ? { key: u.key } : {}),
      reason: typeof u.reason === "string" ? u.reason : "",
    });
  }
  const fixes: Fix[] = [];
  for (const raw of Array.isArray(o.fixes) ? o.fixes : []) {
    const f = (raw ?? {}) as Record<string, unknown>;
    if (typeof f.target !== "string" || !targets.includes(f.target)) {
      problems.push(
        `fix.target ${JSON.stringify(f.target)} is not one of ${targets.join(", ") || "(none configured)"}`,
      );
      continue;
    }
    if (
      typeof f.title !== "string" ||
      typeof f.instruction !== "string" ||
      f.instruction.length < 20
    ) {
      problems.push("a fix needs a title and an instruction a stranger could carry out");
      continue;
    }
    if (typeof f.conformity !== "string" || f.conformity.trim().length < 20) {
      problems.push(
        "a fix needs its conformity: the rules and accepted decisions it touches, and why it conforms",
      );
      continue;
    }
    fixes.push({
      target: f.target,
      title: f.title,
      instruction: f.instruction,
      conformity: f.conformity,
      ...(typeof f.revises === "string" && f.revises.trim().length > 0
        ? { revises: f.revises }
        : {}),
    });
  }
  const asked =
    typeof o.needsHuman === "string" && o.needsHuman.length > 0 ? o.needsHuman : undefined;
  if (asked !== undefined && unblock.length > 0) {
    problems.push("needsHuman and unblock contradict: a stop for a person is not resumed");
  }
  // A change that would revisit an accepted decision is a product choice, not the supervisor's.
  const revising = fixes.filter((fix) => fix.revises !== undefined);
  const needsHuman =
    asked ??
    (revising.length === 0
      ? undefined
      : `A person must decide: ${revising.map((fix) => `"${fix.title}" would revise ${fix.revises}`).join("; ")}.`);
  if (o.unblockAfterFixes === true && unblock.length === 0) {
    problems.push("unblockAfterFixes is true but there is nothing to unblock");
  }
  if (problems.length > 0) {
    return { ok: false, reason: problems.join("; ") };
  }
  return {
    ok: true,
    decision: {
      summary,
      cause,
      evidence,
      confidence: confidence as Decision["confidence"],
      unblockAfterFixes: o.unblockAfterFixes === true,
      unblock,
      fixes,
      ...(needsHuman === undefined ? {} : { needsHuman }),
    },
  };
}
