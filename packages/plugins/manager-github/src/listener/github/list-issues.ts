import { callSignal, type GithubClient, readFailure } from "../../github/client.js";
import type { Invocation } from "../types.js";

export type ListResult =
  | { ok: true; entries: unknown[]; lastPageReached: boolean }
  /** The Source stopped being readable: a refusal, or nobody answered in the budget. */
  | { ok: false; interrupted: boolean; detail: string };

export type ListRequest = {
  invocation: Invocation;
  github: GithubClient;
  /** Deliver only what moved at or after this instant; the Cursor drops the rest. */
  sinceIso: string | undefined;
  page: number;
  deadlineMs: number;
  now: () => number;
  shouldInterrupt: () => boolean;
};

/**
 * One page of the Source. Ascending on `updated`, so a scan walks the
 * repository in the order the Cursor is built from. Never writes: this Block
 * only reads.
 */
export async function listIssues(request: ListRequest): Promise<ListResult> {
  const { invocation } = request;
  const call = callSignal(request.deadlineMs, request.now, request.shouldInterrupt);
  try {
    const response = await request.github.request("GET /repos/{owner}/{repo}/issues", {
      owner: invocation.repo.owner,
      repo: invocation.repo.name,
      state: invocation.state,
      sort: "updated",
      direction: "asc",
      per_page: invocation.perPage,
      page: request.page,
      ...(invocation.labels.length > 0 ? { labels: invocation.labels.join(",") } : {}),
      ...(request.sinceIso !== undefined ? { since: request.sinceIso } : {}),
      request: { signal: call.signal },
    });
    const entries = response.data as unknown[];
    return { ok: true, entries, lastPageReached: entries.length < invocation.perPage };
  } catch (error) {
    if (request.shouldInterrupt()) {
      return { ok: false, interrupted: true, detail: "Stopped by a signal." };
    }
    return { ok: false, interrupted: false, detail: readFailure(error).detail };
  } finally {
    call.release();
  }
}
