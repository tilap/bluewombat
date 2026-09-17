import { callSignal, type GithubClient, readFailure } from "../../github/client.js";
import type { Invocation } from "../types.js";
import type { CallContext, TargetResult } from "./result.js";

const PER_PAGE = 100;

/** The label this Event stands for, e.g. `mason:escalated`. */
export function labelFor(prefix: string, event: string): string {
  return `${prefix}${event}`;
}

export type LabelSync = { added?: string; removed: string[] };

function failed<T>(error: unknown, context: CallContext): TargetResult<T> {
  if (context.shouldInterrupt()) {
    return { kind: "interrupted" };
  }
  return { kind: "unreportable", detail: readFailure(error).detail };
}

/**
 * Move the Thread's state label to this Event.
 *
 * Only labels carrying the prefix are touched: a `project:` or a `bug` label is
 * somebody else's, and a report that rewrites the issue's whole label set is a
 * report that destroys data.
 */
export async function syncStateLabel(
  invocation: Invocation,
  github: GithubClient,
  context: CallContext,
  prefix: string,
): Promise<TargetResult<LabelSync>> {
  const target = labelFor(prefix, invocation.event);
  const issue = {
    owner: invocation.repo.owner,
    repo: invocation.repo.name,
    issue_number: invocation.issue,
  };

  let present: string[];
  const listing = callSignal(context.deadlineMs, context.now, context.shouldInterrupt);
  try {
    const response = await github.request(
      "GET /repos/{owner}/{repo}/issues/{issue_number}/labels",
      {
        ...issue,
        per_page: PER_PAGE,
        request: { signal: listing.signal },
      },
    );
    present = response.data.map((label) => label.name);
  } catch (error) {
    return failed(error, context);
  } finally {
    listing.release();
  }

  const stale = present.filter(
    (name) => name.toLowerCase().startsWith(prefix.toLowerCase()) && name !== target,
  );

  const removed: string[] = [];
  for (const name of stale) {
    const call = callSignal(context.deadlineMs, context.now, context.shouldInterrupt);
    try {
      await github.request("DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}", {
        ...issue,
        name,
        request: { signal: call.signal },
      });
      removed.push(name);
    } catch (error) {
      return failed(error, context);
    } finally {
      call.release();
    }
  }

  if (present.includes(target)) {
    return { kind: "ok", value: { removed } };
  }

  const adding = callSignal(context.deadlineMs, context.now, context.shouldInterrupt);
  try {
    await github.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", {
      ...issue,
      labels: [target],
      request: { signal: adding.signal },
    });
  } catch (error) {
    return failed(error, context);
  } finally {
    adding.release();
  }
  return { kind: "ok", value: { added: target, removed } };
}
