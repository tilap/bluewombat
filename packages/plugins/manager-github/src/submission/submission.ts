import type { FoldResult, SubmissionRequest, SubmissionResult } from "@bluewombat/manager-kit";
import { PRODUCT } from "@bluewombat/manager-kit";
import { callSignal, type GithubClient, readFailure } from "../github/client.js";
import { issueNumberFromExternalId } from "../issue-number.js";
import type { Repository } from "../repo.js";

/**
 * A pull request is this Authority's Submission.
 *
 * It opens one and it merges one. Whether the work is good is decided nowhere in
 * this file: the `ci-green` Gate reads the checks and answers, like any other
 * Gate. An Authority acts; it does not judge.
 *
 * The reference travels as the pull request's address: it identifies the
 * Submission here, and it is the one thing worth showing a human reading the
 * issue — a path on the machine that ran is of no use to them.
 */

export type SubmissionContext = {
  repo: Repository;
  github: GithubClient;
  deadlineMs: number;
  now: () => number;
  shouldInterrupt: () => boolean;
  /** Leave the feature branch on the remote after the fold. Default: delete it. */
  keepBranch?: boolean | undefined;
};

export function referenceOf(repo: Repository, number: number): string {
  return `https://github.com/${repo.owner}/${repo.name}/pull/${number}`;
}

export function numberFromReference(reference: string): number | undefined {
  const matched = /\/pull\/(\d+)\s*$/.exec(reference.trim());
  if (matched?.[1] === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(matched[1], 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export async function submitPullRequest(
  input: SubmissionRequest,
  context: SubmissionContext,
): Promise<SubmissionResult> {
  const existing = await openPullRequestFor(input.ref, context);
  if (existing.kind === "unavailable") {
    return { outcome: "unavailable" };
  }
  if (existing.kind === "found") {
    // Republished to the same place: the Authority is judging the same
    // Submission with new content, so there is nothing to open.
    return { outcome: "submitted", reference: referenceOf(context.repo, existing.number) };
  }

  const call = callSignal(context.deadlineMs, context.now, context.shouldInterrupt);
  try {
    const response = await context.github.request("POST /repos/{owner}/{repo}/pulls", {
      owner: context.repo.owner,
      repo: context.repo.name,
      title: titleOf(input),
      head: input.ref,
      base: input.target,
      body: bodyOf(input),
      request: { signal: call.signal },
    });
    return { outcome: "submitted", reference: referenceOf(context.repo, response.data.number) };
  } catch (error) {
    const failure = readFailure(error);
    return failure.permanent
      ? { outcome: "refused", reason: failure.detail }
      : { outcome: "unavailable" };
  } finally {
    call.release();
  }
}

export async function foldPullRequest(
  reference: string,
  context: SubmissionContext,
): Promise<FoldResult> {
  const number = numberFromReference(reference);
  if (number === undefined) {
    return { outcome: "unavailable" };
  }
  const call = callSignal(context.deadlineMs, context.now, context.shouldInterrupt);
  try {
    // One commit on the work line per feature, saying what the pull request
    // was opened with — the message decided then and kept on it, so a restart
    // loses nothing — and closing the issue. The branch keeps the
    // Subtask-by-Subtask history for whoever wants it.
    const pull = await context.github.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner: context.repo.owner,
      repo: context.repo.name,
      pull_number: number,
      request: { signal: call.signal },
    });
    const merged = await context.github.request(
      "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge",
      {
        owner: context.repo.owner,
        repo: context.repo.name,
        pull_number: number,
        merge_method: "squash",
        ...commitOf(pull.data.title, pull.data.body ?? ""),
        request: { signal: call.signal },
      },
    );
    // The branch has done its job once the work line holds the squash. It is
    // deleted best-effort: the fold happened whatever this call says, and a
    // branch left behind is clutter, not a failure.
    if (context.keepBranch !== true) {
      await deleteBranch(pull.data.head.ref, context, call.signal);
    }
    const reference = merged.data.sha;
    return typeof reference === "string" ? { outcome: "folded", reference } : { outcome: "folded" };
  } catch (error) {
    const failure = readFailure(error);
    if (failure.status === 405 || failure.status === 409) {
      return { outcome: "conflict", reason: failure.detail };
    }
    return failure.permanent
      ? { outcome: "conflict", reason: failure.detail }
      : { outcome: "unavailable" };
  } finally {
    call.release();
  }
}

async function deleteBranch(
  ref: string,
  context: SubmissionContext,
  signal: AbortSignal,
): Promise<void> {
  try {
    await context.github.request("DELETE /repos/{owner}/{repo}/git/refs/{ref}", {
      owner: context.repo.owner,
      repo: context.repo.name,
      ref: `heads/${ref}`,
      request: { signal },
    });
  } catch {
    // Already gone, protected, or unreachable: the fold stands either way.
  }
}

/**
 * The fold's message rides on the pull request, invisibly, from the moment it
 * is opened: subject line first, then the body. `fold` reads it back here.
 */
const COMMIT_MESSAGE_OPEN = "<!-- commit-message\n";
const COMMIT_MESSAGE_CLOSE = "\n-->";

/** `commit_title` and `commit_message` for the squash, from what the pull request carries. */
export function commitOf(
  pullTitle: string,
  pullBody: string,
): { commit_title: string; commit_message: string } {
  const closes = /^Closes #\d+$/m.exec(pullBody)?.[0];
  const start = pullBody.indexOf(COMMIT_MESSAGE_OPEN);
  const end = start < 0 ? -1 : pullBody.indexOf(COMMIT_MESSAGE_CLOSE, start);
  if (start < 0 || end < 0) {
    return { commit_title: pullTitle, commit_message: closes ?? "" };
  }
  const stored = pullBody.slice(start + COMMIT_MESSAGE_OPEN.length, end).trim();
  const [subject, ...rest] = stored.split("\n");
  const body = rest.join("\n").trim();
  const withClose = [body, closes].filter((part) => part !== undefined && part.length > 0);
  return {
    commit_title: subject?.trim() || pullTitle,
    commit_message: withClose.join("\n\n"),
  };
}

/**
 * The issue's title, made a pull request title: no trailing full stop, and
 * the issue's number where GitHub links it.
 */
export function titleOf(input: Pick<SubmissionRequest, "key" | "title">): string {
  const issue = issueNumberFromExternalId(input.key);
  const base = (input.title ?? "").trim().replace(/[.\s]+$/, "");
  const title = base.length > 0 ? base : `${PRODUCT} ${input.key}`;
  return issue === undefined ? title : `${title} (#${issue})`;
}

/**
 * What the pull request delivers, from what was asked and what was planned.
 * Nothing here is generated: the intention is the human's words, the steps are
 * the Plan's. `Closes #N` lets GitHub close the issue when this is merged.
 */
export function bodyOf(
  input: Pick<SubmissionRequest, "key" | "title" | "intention" | "steps" | "description">,
): string {
  const sections: string[] = [];
  // What the reader sees first: the Project's words when a Describer gave
  // them, else what the human asked, as they wrote it.
  const slotBody = input.description?.body?.trim() ?? "";
  const intention = input.intention?.trim() ?? "";
  const description = slotBody.length > 0 ? slotBody : intention;
  if (description.length > 0) {
    sections.push(description);
  }
  if (input.steps !== undefined && input.steps.length > 0) {
    sections.push(
      ["## Changes", ...input.steps.map((line, at) => `${at + 1}. ${line}`)].join("\n"),
    );
  }
  const issue = issueNumberFromExternalId(input.key);
  sections.push(issue === undefined ? `Key: \`${input.key}\`` : `Closes #${issue}`);
  // The fold's message, decided now and kept here: the Describer's words, or
  // the title and the intention — the human's own — when there is no slot.
  const subject = input.description?.subject.trim() || titleOf(input);
  const stored = [subject, description].filter((part) => part.length > 0).join("\n\n");
  sections.push(`${COMMIT_MESSAGE_OPEN}${stored}${COMMIT_MESSAGE_CLOSE}`);
  return sections.join("\n\n");
}

type Lookup = { kind: "found"; number: number } | { kind: "none" } | { kind: "unavailable" };

async function openPullRequestFor(head: string, context: SubmissionContext): Promise<Lookup> {
  const call = callSignal(context.deadlineMs, context.now, context.shouldInterrupt);
  try {
    const response = await context.github.request("GET /repos/{owner}/{repo}/pulls", {
      owner: context.repo.owner,
      repo: context.repo.name,
      head: `${context.repo.owner}:${head}`,
      state: "open",
      per_page: 1,
      request: { signal: call.signal },
    });
    const first = response.data[0];
    return first === undefined ? { kind: "none" } : { kind: "found", number: first.number };
  } catch {
    return { kind: "unavailable" };
  } finally {
    call.release();
  }
}
