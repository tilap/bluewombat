import type { ProbeResult } from "@bluewombat/manager-kit";
import { callSignal, type GithubClient, readFailure } from "../github/client.js";
import type { Repository } from "../repo.js";

export type ProbeIssueRequest = {
  github: GithubClient;
  repo: Repository;
  number: number;
  deadlineMs: number;
  now: () => number;
  shouldInterrupt: () => boolean;
};

/**
 * Whether this issue is still an intention the Project can act on.
 *
 * Open is present. Closed is gone — the same intent as a cancel delivery.
 * A 404 is gone too: deleted, or transferred. Every other failure is
 * unavailable: a missed read must not abandon work.
 */
export async function probeIssue(request: ProbeIssueRequest): Promise<ProbeResult> {
  const call = callSignal(request.deadlineMs, request.now, request.shouldInterrupt);
  try {
    const response = await request.github.request(
      "GET /repos/{owner}/{repo}/issues/{issue_number}",
      {
        owner: request.repo.owner,
        repo: request.repo.name,
        issue_number: request.number,
        request: { signal: call.signal },
      },
    );
    const issue = response.data as unknown;
    if (issue === null || typeof issue !== "object" || Array.isArray(issue)) {
      return "unavailable";
    }
    const state = (issue as { state?: unknown }).state;
    if (state === "open") {
      return "present";
    }
    if (state === "closed") {
      return "gone";
    }
    return "unavailable";
  } catch (error) {
    if (request.shouldInterrupt()) {
      return "interrupted";
    }
    const status = readFailure(error).status;
    if (status === 404 || status === 410) {
      return "gone";
    }
    return "unavailable";
  } finally {
    call.release();
  }
}
