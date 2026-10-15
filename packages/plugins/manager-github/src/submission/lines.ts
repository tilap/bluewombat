import type { LineResult, SettledResult } from "@bluewombat/manager-kit";
import { callSignal, readFailure } from "../github/client.js";
import { numberFromReference, type SubmissionContext } from "./submission.js";

/**
 * Cut a branch from another: the line a Feature's Tickets land on.
 *
 * A line that is already there is a success, so asking again after a restart
 * does nothing. A refusal that will not change on a retry (the branch to cut
 * from does not exist, the token cannot write) is a `refused`; anything else
 * is `unavailable` and is tried again.
 */
export async function openLine(
  input: { line: string; from: string },
  context: SubmissionContext,
): Promise<LineResult> {
  const call = callSignal(context.deadlineMs, context.now, context.shouldInterrupt);
  try {
    const base = await context.github.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
      owner: context.repo.owner,
      repo: context.repo.name,
      ref: `heads/${input.from}`,
      request: { signal: call.signal },
    });
    try {
      await context.github.request("POST /repos/{owner}/{repo}/git/refs", {
        owner: context.repo.owner,
        repo: context.repo.name,
        ref: `refs/heads/${input.line}`,
        sha: base.data.object.sha,
        request: { signal: call.signal },
      });
    } catch (error) {
      // "Reference already exists": the line was cut by an earlier pass.
      if (readFailure(error).status !== 422) {
        throw error;
      }
    }
    return { outcome: "opened" };
  } catch (error) {
    const failure = readFailure(error);
    return failure.permanent
      ? { outcome: "refused", reason: failure.detail }
      : { outcome: "unavailable" };
  } finally {
    call.release();
  }
}

/** Delete a line nobody will fold. Already gone, protected or unreachable: nothing more to do. */
export async function dropLine(line: string, context: SubmissionContext): Promise<void> {
  const call = callSignal(context.deadlineMs, context.now, context.shouldInterrupt);
  try {
    await context.github.request("DELETE /repos/{owner}/{repo}/git/refs/{ref}", {
      owner: context.repo.owner,
      repo: context.repo.name,
      ref: `heads/${line}`,
      request: { signal: call.signal },
    });
  } catch {
    // The line is not worth a failure.
  } finally {
    call.release();
  }
}

/** Where a pull request stands: merged by whoever merged it, closed without, or still open. */
export async function settledPullRequest(
  reference: string,
  context: SubmissionContext,
): Promise<SettledResult> {
  const number = numberFromReference(reference);
  if (number === undefined) {
    return "unavailable";
  }
  const call = callSignal(context.deadlineMs, context.now, context.shouldInterrupt);
  try {
    const pull = await context.github.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner: context.repo.owner,
      repo: context.repo.name,
      pull_number: number,
      request: { signal: call.signal },
    });
    if (pull.data.merged === true) {
      return "folded";
    }
    return pull.data.state === "closed" ? "closed" : "open";
  } catch {
    return "unavailable";
  } finally {
    call.release();
  }
}
