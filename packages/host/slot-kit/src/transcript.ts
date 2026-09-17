import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentExtras, AgentRun, AgentUsage } from "./agent.js";

/**
 * One file per turn of the loop, written only when a Project asks for one.
 *
 * The journal Host keeps films the system: which phase ran, what each check
 * answered. It cannot film this, because the prompt and the agent's answer
 * exist nowhere but inside the slot — by the time a result reaches Host it is
 * one word. Without them a loop that misbehaves cannot be read back, only
 * guessed at.
 *
 * Off unless `dir` is given, and that is not caution for its own sake: a
 * transcript is the project's own material — its code, its conventions, its
 * failures — written to disk in the clear. Whoever turns it on should mean it.
 *
 * `parts` is what to keep. Timing is cheap and says nothing about the project,
 * so it is worth keeping when the rest is not. Skills and usage are header
 * facts like duration: always written when the wrapper passed them (including
 * `null` = unknown).
 */
export const TRANSCRIPT_PARTS = ["prompt", "stdout", "stderr", "timing"] as const;

export type TranscriptPart = (typeof TRANSCRIPT_PARTS)[number];

export type TranscriptSpec = {
  /** No directory, no transcript. */
  dir?: string | undefined;
  parts?: readonly string[] | undefined;
  /** What this Task belongs to; one directory per context. */
  context?: string | undefined;
  id?: string | undefined;
  attempt?: string | number | undefined;
  slot?: string | undefined;
  bin?: string | undefined;
  args?: readonly string[] | undefined;
  prompt?: string | undefined;
};

export type Transcript = { write: (run: AgentRun, extras?: AgentExtras) => void };

export function openTranscript(spec: TranscriptSpec): Transcript {
  if (spec.dir === undefined) {
    return { write() {} };
  }
  const dirName = spec.dir;
  const parts = new Set<string>(spec.parts ?? TRANSCRIPT_PARTS);
  return {
    write(run, extras) {
      try {
        const dir = join(dirName, slug(spec.context ?? "no-context"));
        mkdirSync(dir, { recursive: true });
        const stamp = (run.startedAt ?? new Date()).toISOString().replace(/[-:]|\.\d+/g, "");
        const name = `${slug(spec.id ?? "task")}-attempt-${spec.attempt ?? 1}-${stamp}.md`;
        writeFileSync(join(dir, name), page(spec, run, parts, extras));
      } catch (error) {
        // A transcript is a record of the run, not part of it. Losing one is
        // worth a word on stderr and nothing more.
        process.stderr.write(`Could not write the transcript: ${messageOf(error)}\n`);
      }
    },
  };
}

function page(
  spec: TranscriptSpec,
  run: AgentRun,
  parts: ReadonlySet<string>,
  extras: AgentExtras | undefined,
): string {
  const lines = [`# ${spec.id ?? "task"} · attempt ${spec.attempt ?? 1}`, ""];
  const facts: [string, string | undefined][] = [
    ["context", spec.context],
    ["slot", spec.slot],
    ["agent", spec.bin],
  ];
  if (parts.has("timing")) {
    facts.push(
      ["started", run.startedAt?.toISOString()],
      ["ended", run.endedAt?.toISOString()],
      [
        "duration",
        run.durationMs === undefined ? undefined : `${(run.durationMs / 1000).toFixed(1)}s`,
      ],
    );
  }
  facts.push(
    ["exit", run.error !== undefined ? `did not start: ${run.error.message}` : String(run.code)],
    ["signal", run.signal ?? undefined],
  );
  if (extras !== undefined) {
    facts.push(["skills", skillsLabel(extras.skills)], ["usage", usageLabel(extras.usage)]);
  }
  for (const [name, value] of facts) {
    if (value !== undefined && value !== null && value !== "") {
      lines.push(`- ${name}: ${value}`);
    }
  }
  if (parts.has("prompt")) {
    // The prompt is one of these arguments and has its own section below;
    // repeated here it would bury the flags that say which model ran.
    const shown = (spec.args ?? []).map((arg) => (arg === spec.prompt ? "<prompt>" : arg));
    lines.push("", "## Invocation", "", block(shown.join(" ")));
    lines.push("", "## Prompt", "", block(spec.prompt ?? ""));
  }
  if (parts.has("stdout")) {
    lines.push("", "## stdout", "", block(run.stdout ?? ""));
  }
  if (parts.has("stderr")) {
    lines.push("", "## stderr", "", block(run.stderr ?? ""));
  }
  return `${lines.join("\n")}\n`;
}

/** A fence longer than any run of backticks inside, so agent output survives it. */
function block(text: string): string {
  const body = text.trim();
  if (body.length === 0) {
    return "_(empty)_";
  }
  let longest = 0;
  for (const found of body.matchAll(/`+/g)) {
    longest = Math.max(longest, found[0].length);
  }
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${body}\n${fence}`;
}

function slug(value: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.length === 0 ? "unnamed" : cleaned.slice(0, 80);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `null` is unknown; `[]` is none; otherwise the names in order. */
export function skillsLabel(skills: string[] | null): string {
  if (skills === null) {
    return "unknown";
  }
  if (skills.length === 0) {
    return "(none)";
  }
  return skills.join(", ");
}

/** `null` is unknown; otherwise token counts and optional USD cost. */
export function usageLabel(usage: AgentUsage | null): string {
  if (usage === null) {
    return "unknown";
  }
  const cost =
    usage.costUsd === null ? "" : `, costUsd=${usage.costUsd}`;
  return `input=${usage.input} output=${usage.output} cacheRead=${usage.cacheRead} cacheWrite=${usage.cacheWrite}${cost}`;
}
