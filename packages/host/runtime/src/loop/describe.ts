import type { PassSpec } from "../config/types.js";
import { runSlot } from "./run-slot.js";

/**
 * How a delivered feature describes itself is the Project's decision, not
 * Host's: a team has conventions, and an agent can read the change and
 * follow them. The Describer slot is where that lives. Host spawns it once
 * per feature, in the feature workspace where the whole change is, tells it
 * what was asked, and takes one JSON line back: `{ subject, body? }`. What
 * the Authority makes of those words is the manager's business — for GitHub,
 * the fold's message and the pull request's text. A Subtask is never
 * described: its fold is folded again into the feature's, and words spent on
 * it are words wasted.
 *
 * A slot that fails — cannot run, answers nothing readable, subject empty —
 * is not a reason to lose the Submission: the caller keeps the words it had,
 * and the journal says the slot was skipped.
 */
export type DescribeInput = {
  id: string;
  /** The issue's title, as the human wrote it. */
  title: string;
  /** The issue's body, as the human wrote it. */
  intention: string;
  /** The work line the change will land on, so the slot can diff against it. */
  target: string;
  /** The feature workspace; the slot may read its diff. */
  cwd: string;
};

export type Description = { subject: string; body?: string };

export type DescribeAnswer = { ok: true; description: Description } | { ok: false; detail: string };

export async function describe(slot: PassSpec, input: DescribeInput): Promise<DescribeAnswer> {
  const [command, ...rest] = slot.cmd;
  if (command === undefined) {
    return { ok: false, detail: "the Describer has no command" };
  }
  const run = await runSlot({
    command,
    args: [
      ...rest,
      "--id",
      input.id,
      // A Describer keeping a record of its turn files it under the feature,
      // the way every other slot does. Without this its transcripts land in
      // `no-context/` and the feature has to be read back out of the filename.
      "--context",
      input.id,
      "--title",
      input.title,
      "--intention",
      input.intention,
      "--target",
      input.target,
    ],
    cwd: input.cwd,
    timeoutMs: slot.timeoutMs,
  });
  if (run.error !== undefined) {
    return { ok: false, detail: `Describer could not run: ${run.error.message}` };
  }
  const answer = lastJsonLine(run.stdout);
  if (answer === undefined) {
    const detail = run.stderr.trim().slice(-500);
    return { ok: false, detail: `Describer stdout is not a JSON object. ${detail}`.trim() };
  }
  const subject = typeof answer.subject === "string" ? answer.subject.trim() : "";
  if (subject.length === 0) {
    return { ok: false, detail: "Describer answered no subject." };
  }
  const body = typeof answer.body === "string" ? answer.body.trim() : "";
  return { ok: true, description: body.length === 0 ? { subject } : { subject, body } };
}

function lastJsonLine(stdout: string): Record<string, unknown> | undefined {
  const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed: unknown = JSON.parse(lines[i] ?? "");
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // not this line
    }
  }
  return undefined;
}
