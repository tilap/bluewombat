import type { Repository } from "../repo.js";
import { callSignal, type GithubClient, readFailure } from "./client.js";

const PER_PAGE = 100;
const MAX_PAGES = 10;

export type IssueList =
  | { kind: "listed"; issues: Record<string, unknown>[] }
  | { kind: "unavailable"; detail: string }
  | { kind: "interrupted" };

export type ListRequest = {
  github: GithubClient;
  repo: Repository;
  number: number;
  deadlineMs: number;
  now: () => number;
  shouldInterrupt: () => boolean;
};

/** The issues that block this one, as GitHub holds the dependency. */
export async function listBlockers(request: ListRequest): Promise<IssueList> {
  return await listPages(
    request,
    "GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by",
  );
}

/** The sub-issues of this one: the Tickets of a Feature. */
export async function listSubIssues(request: ListRequest): Promise<IssueList> {
  return await listPages(request, "GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues");
}

async function listPages(request: ListRequest, route: string): Promise<IssueList> {
  const issues: Record<string, unknown>[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const call = callSignal(request.deadlineMs, request.now, request.shouldInterrupt);
    try {
      const response = await request.github.request(route, {
        owner: request.repo.owner,
        repo: request.repo.name,
        issue_number: request.number,
        per_page: PER_PAGE,
        page,
        request: { signal: call.signal },
      });
      const data = response.data as unknown;
      if (!Array.isArray(data)) {
        return { kind: "unavailable", detail: "GitHub answered a list with something else." };
      }
      for (const item of data) {
        if (item !== null && typeof item === "object" && !Array.isArray(item)) {
          issues.push(item as Record<string, unknown>);
        }
      }
      if (data.length < PER_PAGE) {
        return { kind: "listed", issues };
      }
    } catch (error) {
      if (request.shouldInterrupt()) {
        return { kind: "interrupted" };
      }
      return { kind: "unavailable", detail: readFailure(error).detail };
    } finally {
      call.release();
    }
  }
  return { kind: "listed", issues };
}
