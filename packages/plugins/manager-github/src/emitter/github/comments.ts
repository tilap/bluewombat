import { callSignal, type GithubClient, readFailure } from "../../github/client.js";
import type { Invocation } from "../types.js";
import type { CallContext, TargetResult } from "./result.js";

const PER_PAGE = 100;
/** A Thread nobody would scroll; past it, the idempotence scan gives up. */
const MAX_PAGES = 50;

function failed<T>(error: unknown, context: CallContext): TargetResult<T> {
  if (context.shouldInterrupt()) {
    return { kind: "interrupted" };
  }
  return { kind: "unreportable", detail: readFailure(error).detail };
}

/**
 * Every comment body already in the Thread. Read only for idempotence: this
 * Block never edits or deletes a comment, its own included.
 */
export async function listCommentBodies(
  invocation: Invocation,
  github: GithubClient,
  context: CallContext,
): Promise<TargetResult<string[]>> {
  const bodies: string[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const call = callSignal(context.deadlineMs, context.now, context.shouldInterrupt);
    try {
      const response = await github.request(
        "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
        {
          owner: invocation.repo.owner,
          repo: invocation.repo.name,
          issue_number: invocation.issue,
          per_page: PER_PAGE,
          page,
          request: { signal: call.signal },
        },
      );
      for (const comment of response.data) {
        if (typeof comment.body === "string") {
          bodies.push(comment.body);
        }
      }
      if (response.data.length < PER_PAGE) {
        return { kind: "ok", value: bodies };
      }
    } catch (error) {
      return failed(error, context);
    } finally {
      call.release();
    }
  }
  return {
    kind: "unreportable",
    detail: `The Thread holds more than ${MAX_PAGES * PER_PAGE} comments; idempotence cannot be established.`,
  };
}

export type CreatedComment = { url: string | undefined };

/** Append one comment. One request, so it lands whole or not at all. */
export async function createComment(
  invocation: Invocation,
  github: GithubClient,
  context: CallContext,
  body: string,
): Promise<TargetResult<CreatedComment>> {
  const call = callSignal(context.deadlineMs, context.now, context.shouldInterrupt);
  try {
    const response = await github.request(
      "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
      {
        owner: invocation.repo.owner,
        repo: invocation.repo.name,
        issue_number: invocation.issue,
        body,
        request: { signal: call.signal },
      },
    );
    return { kind: "ok", value: { url: response.data.html_url } };
  } catch (error) {
    return failed(error, context);
  } finally {
    call.release();
  }
}
