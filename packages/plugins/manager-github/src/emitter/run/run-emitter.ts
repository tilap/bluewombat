import type { GithubClient } from "../../github/client.js";
import { createComment, listCommentBodies } from "../github/comments.js";
import { syncStateLabel } from "../github/labels.js";
import type { CallContext } from "../github/result.js";
import type { ProgressWriter } from "../progress/emit.js";
import { renderEvent } from "../render/render-event.js";
import { hasEventId } from "../thread/marker.js";
import type { Invocation, RunOutcome } from "../types.js";

export type RunResult = {
  outcome: RunOutcome;
  /** `<owner>/<name>#<issue>`: the Thread this Event was appended to. */
  thread: string;
  commentUrl?: string;
  detail?: string;
  exitCode: number;
};

export type RunOptions = {
  invocation: Invocation;
  /** The authenticated channel to the Target. Not needed by a dry run. */
  github?: GithubClient;
  write?: ProgressWriter;
  now?: () => number;
  interruptFlag?: { interrupted: boolean };
};

function exitCodeFor(outcome: RunOutcome): number {
  switch (outcome) {
    case "reported":
    case "duplicate":
    case "rendered":
      return 0;
    case "unreportable":
      return 1;
    case "invalid-invocation":
      return 2;
    case "interrupted":
      return 130;
  }
}

export function invalidInvocationResult(write: ProgressWriter, reason: string): RunResult {
  write({ event: "result", outcome: "invalid-invocation", detail: reason });
  return {
    outcome: "invalid-invocation",
    thread: "",
    detail: reason,
    exitCode: exitCodeFor("invalid-invocation"),
  };
}

/**
 * Run one FeatureEmitter invocation to a run outcome.
 */
export async function runEmitter(options: RunOptions): Promise<RunResult> {
  const { invocation } = options;
  const write = options.write ?? (() => {});
  const now = options.now ?? (() => Date.now());
  const interruptState = options.interruptFlag ?? { interrupted: false };
  const shouldInterrupt = (): boolean => interruptState.interrupted;

  const thread = `${invocation.repo.owner}/${invocation.repo.name}#${invocation.issue}`;

  let commentUrl: string | undefined;
  const finish = (outcome: RunOutcome, detail?: string): RunResult => {
    const line: Record<string, unknown> = {
      event: "result",
      outcome,
      key: invocation.key,
      project: invocation.project,
      thread,
    };
    if (commentUrl !== undefined) {
      line.comment_url = commentUrl;
    }
    if (detail !== undefined) {
      line.detail = detail;
    }
    write(line);

    const result: RunResult = { outcome, thread, exitCode: exitCodeFor(outcome) };
    if (commentUrl !== undefined) {
      result.commentUrl = commentUrl;
    }
    if (detail !== undefined) {
      result.detail = detail;
    }
    return result;
  };

  if (shouldInterrupt()) {
    return finish("interrupted");
  }

  const rendered = renderEvent(invocation);

  if (invocation.dryRun) {
    write({
      event: "render",
      key: invocation.key,
      thread,
      body: rendered.body,
      record: rendered.record,
    });
    return finish("rendered");
  }

  if (options.github === undefined) {
    return finish("unreportable", "No authenticated channel was given for the Target.");
  }
  const github = options.github;
  const context: CallContext = {
    deadlineMs: now() + invocation.durationMs,
    now,
    shouldInterrupt,
  };

  if (invocation.eventId !== undefined) {
    const listed = await listCommentBodies(invocation, github, context);
    if (listed.kind === "interrupted") {
      return finish("interrupted");
    }
    if (listed.kind === "unreportable") {
      return finish("unreportable", listed.detail);
    }
    if (hasEventId(listed.value, invocation.eventId)) {
      // Said already, but the label may have moved since — a fresh ledger
      // re-admitting the issue, a human — and it must show this Event again.
      await syncLabel();
      return finish("duplicate");
    }
  }

  const created = await createComment(invocation, github, context, rendered.body);
  if (created.kind === "interrupted") {
    return finish("interrupted");
  }
  if (created.kind === "unreportable") {
    return finish("unreportable", created.detail);
  }
  commentUrl = created.value.url;

  // The Event is committed. The label is a rendering of it: failing to move it
  // leaves the report standing, the way a missing section leaves the truth.
  await syncLabel();

  return finish("reported");

  async function syncLabel(): Promise<void> {
    if (invocation.labelPrefix === undefined) {
      return;
    }
    const synced = await syncStateLabel(invocation, github, context, invocation.labelPrefix);
    write({
      event: "labels-finished",
      key: invocation.key,
      thread,
      result: synced.kind === "ok" ? "moved" : synced.kind,
      ...(synced.kind === "ok" ? { added: synced.value.added, removed: synced.value.removed } : {}),
      ...(synced.kind === "unreportable" ? { detail: synced.detail } : {}),
    });
  }
}
