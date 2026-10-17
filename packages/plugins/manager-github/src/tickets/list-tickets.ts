import type { FeatureRef, TicketEntry, TicketsResult } from "@bluewombat/manager-kit";
import { normalize } from "../adapter/normalize/normalize.js";
import { listBlockers, listSubIssues } from "../github/blockers.js";
import type { GithubClient } from "../github/client.js";
import { issueNumberFromExternalId, issueNumberFromPayload } from "../issue-number.js";
import { payloadHasLabel } from "../labels.js";
import type { Repository } from "../repo.js";

export type ListTicketsRequest = {
  github: GithubClient;
  repo: Repository;
  manager: string;
  feature: FeatureRef;
  defaultPriority: number;
  projectLabelPrefix: string;
  priorityLabelPrefix: string;
  resumeLabel: string;
  ticketReadyLabel: string;
  noTestsLabel: string;
  deadlineMs: number;
  now: () => number;
  shouldInterrupt: () => boolean;
};

/**
 * The Tickets of a Feature: its sub-issues, each with what blocks it and the
 * signals it carries.
 *
 * Every failure is `unavailable`, never an empty list: a read that did not
 * answer says nothing about the Tickets, and an empty list would read as a
 * Feature with nothing to make.
 */
export async function listTickets(request: ListTicketsRequest): Promise<TicketsResult> {
  const number = issueNumberFromExternalId(request.feature.key);
  if (number === undefined) {
    return { outcome: "unavailable" };
  }
  const subs = await listSubIssues({ ...request, number });
  if (subs.kind === "interrupted") {
    return { outcome: "interrupted" };
  }
  if (subs.kind === "unavailable") {
    return { outcome: "unavailable" };
  }
  const tickets: TicketEntry[] = [];
  for (const issue of subs.issues) {
    if (issue.pull_request !== undefined && issue.pull_request !== null) {
      continue;
    }
    const own = issueNumberFromPayload(issue);
    if (own === undefined) {
      continue;
    }
    const blockers = await listBlockers({ ...request, number: own });
    if (blockers.kind === "interrupted") {
      return { outcome: "interrupted" };
    }
    if (blockers.kind === "unavailable") {
      return { outcome: "unavailable" };
    }
    const blockedBy = blockers.issues.flatMap((blocker) => {
      const other = issueNumberFromPayload(blocker);
      return other === undefined ? [] : [keyOf(request, other)];
    });
    const entry = entryOf(request, issue, blockedBy);
    if (entry !== undefined) {
      tickets.push(entry);
    }
  }
  return { outcome: "listed", tickets };
}

function keyOf(request: ListTicketsRequest, number: number): string {
  return `${request.manager}:${request.repo.owner}/${request.repo.name}#${number}`;
}

function entryOf(
  request: ListTicketsRequest,
  issue: Record<string, unknown>,
  blockedBy: string[],
): TicketEntry | undefined {
  const normalized = normalize(
    { issue },
    {
      manager: request.manager,
      repo: request.repo,
      defaultProject: request.feature.project,
      defaultPriority: request.defaultPriority,
      projectLabelPrefix: request.projectLabelPrefix,
      priorityLabelPrefix: request.priorityLabelPrefix,
      resumeLabel: request.resumeLabel,
      mergeWhenReadyLabel: "",
      normalizedAt: new Date(request.now()).toISOString(),
    },
  );
  if (!normalized.ok) {
    return undefined;
  }
  const { feature: standard } = normalized;
  const intention = standard.intention ?? standard.title;
  if (intention === undefined) {
    return undefined;
  }
  return {
    ticket: {
      key: standard.key,
      manager: standard.manager,
      external_id: standard.external_id,
      // A Ticket belongs to the Project of its Feature, whatever its labels say.
      project: request.feature.project,
      ...(standard.title === undefined ? {} : { title: standard.title }),
      intention,
      priority: standard.priority,
      blocked_by: blockedBy,
      ...(standard.source === undefined ? {} : { source: standard.source }),
      fingerprint: standard.fingerprint,
      normalized_at: standard.normalized_at,
    },
    task_ready: payloadHasLabel(issue, request.ticketReadyLabel),
    resume: payloadHasLabel(issue, request.resumeLabel),
    no_tests: payloadHasLabel(issue, request.noTestsLabel),
    open: issue.state !== "closed",
  };
}
