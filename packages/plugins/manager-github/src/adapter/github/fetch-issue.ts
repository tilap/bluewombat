import { callSignal, type GithubClient, readFailure } from "../../github/client.js";
import type { Invocation } from "../types.js";

export type FetchResult =
  /** The issue as the API holds it now: the base the raw intention is layered on. */
  | { kind: "merged"; issue: Record<string, unknown> }
  /** Nothing is known about the intention. The same call may answer later. */
  | { kind: "unavailable"; detail: string }
  | { kind: "interrupted" };

export type FetchRequest = {
  invocation: Invocation;
  github: GithubClient;
  number: number;
  deadlineMs: number;
  now: () => number;
  shouldInterrupt: () => boolean;
};

/**
 * Re-read the issue. Every failure is `unavailable`, never `invalid`: a Fetch
 * that did not answer says nothing about the intention.
 */
export async function fetchIssue(request: FetchRequest): Promise<FetchResult> {
  const call = callSignal(request.deadlineMs, request.now, request.shouldInterrupt);
  try {
    const response = await request.github.request(
      "GET /repos/{owner}/{repo}/issues/{issue_number}",
      {
        owner: request.invocation.repo.owner,
        repo: request.invocation.repo.name,
        issue_number: request.number,
        request: { signal: call.signal },
      },
    );
    const issue = response.data as unknown;
    if (issue === null || typeof issue !== "object" || Array.isArray(issue)) {
      return {
        kind: "unavailable",
        detail: "The Fetch answered with something other than an issue.",
      };
    }
    return { kind: "merged", issue: issue as Record<string, unknown> };
  } catch (error) {
    if (request.shouldInterrupt()) {
      return { kind: "interrupted" };
    }
    return { kind: "unavailable", detail: readFailure(error).detail };
  } finally {
    call.release();
  }
}
