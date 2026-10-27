import type {
  AdaptResult,
  BehindResult,
  FeatureTrackerPort,
  FoldResult,
  LineResult,
  ListenResult,
  Manager,
  ProbeResult,
  ReportInput,
  SettledResult,
  SubmissionRequest,
  SubmissionResult,
  TicketsResult,
  TicketTrackerPort,
} from "@bluewombat/manager-kit";
import { runAdapter } from "./adapter/run/run-adapter.js";
import { runEmitter } from "./emitter/run/run-emitter.js";
import type { EventName as GithubEventName } from "./emitter/types.js";
import { createClient } from "./github/client.js";
import { createEtagCache } from "./github/etag-cache.js";
import { issueNumberFromExternalId, issueNumberFromPayload } from "./issue-number.js";
import { payloadHasLabel } from "./labels.js";
import { runListener } from "./listener/run/run-listener.js";
import { probeIssue } from "./probe/probe-issue.js";
import type { Repository } from "./repo.js";
import { settledAlready } from "./settled.js";
import type { StateLabels } from "./state-labels.js";
import { dropLine, openLine, settledPullRequest } from "./submission/lines.js";
import {
  behindPullRequest,
  foldPullRequest,
  type SubmissionContext,
  submitPullRequest,
} from "./submission/submission.js";
import { listTickets } from "./tickets/list-tickets.js";
import { writtenFingerprint } from "./written-fingerprint.js";

const silent = (): void => {};
const MANAGER = "github";
const UNKNOWN_PROJECT = "unknown";
const DEFAULT_MAX_EVENTS = 10_000;
const DEFAULT_MAX_RAW_BYTES = 65_536;
const DEFAULT_PER_PAGE = 100;
const DEFAULT_REQUEST_RETRIES = 2;
const DEFAULT_PROJECT_LABEL_PREFIX = "project:";
const DEFAULT_PRIORITY_LABEL_PREFIX = "priority:";
const MAX_REPORT_CHARS = 8_000;

export const DEFAULT_API_BASE = "https://api.github.com";
export const DEFAULT_TOKEN_ENV = "GITHUB_TOKEN";
export const DEFAULT_RESUME_LABEL = "to-resume";
export const DEFAULT_FEATURE_READY_LABEL = "feature-ready";
export const DEFAULT_TICKET_READY_LABEL = "task-ready";
export const DEFAULT_FEATURE_TEST_LABEL = "feature-test";
export const DEFAULT_SKIP_FEATURE_TEST_LABEL = "skip-feature-test";
export const DEFAULT_MERGE_WHEN_READY_LABEL = "merge-when-ready";
export const DEFAULT_PRIORITY = 50;

export type GithubManagerOptions = {
  repo: Repository;
  token: string;
  durationMs: number;
  interruptFlag: { interrupted: boolean };
  apiBase?: string;
  defaultProject?: string;
  resumeLabel?: string;
  /** On a Feature: its content is final, so its Tickets may be made. */
  featureReadyLabel?: string;
  /** On a Ticket: its specification is final. */
  ticketReadyLabel?: string;
  /** On a Ticket: it holds the feature tests of its Feature. */
  featureTestLabel?: string;
  /** On a Feature: it is not put through the feature-test acceptance check. */
  skipFeatureTestLabel?: string;
  /** On a Feature: its line may be folded without a human. */
  mergeWhenReadyLabel?: string;
  defaultPriority?: number;
  /** When set, each Event also lands on the issue as its label. */
  stateLabels?: StateLabels;
  /** Leave the ticket branch on the remote after a fold. Default: delete it. */
  keepBranch?: boolean;
  /** Replaces the REST API. Tests only. */
  githubFetch?: typeof fetch;
};

/**
 * One repository: its issues are the Features and, as sub-issues, their
 * Tickets; its branches are the lines; its pull requests are the Submissions.
 */
export function createGithubManager(options: GithubManagerOptions): Manager {
  const apiBase = options.apiBase ?? DEFAULT_API_BASE;
  const resumeLabel = options.resumeLabel ?? DEFAULT_RESUME_LABEL;
  const featureReadyLabel = options.featureReadyLabel ?? DEFAULT_FEATURE_READY_LABEL;
  const ticketReadyLabel = options.ticketReadyLabel ?? DEFAULT_TICKET_READY_LABEL;
  const featureTestLabel = options.featureTestLabel ?? DEFAULT_FEATURE_TEST_LABEL;
  const skipFeatureTestLabel = options.skipFeatureTestLabel ?? DEFAULT_SKIP_FEATURE_TEST_LABEL;
  const mergeWhenReadyLabel = options.mergeWhenReadyLabel ?? DEFAULT_MERGE_WHEN_READY_LABEL;
  const defaultPriority = options.defaultPriority ?? DEFAULT_PRIORITY;
  const testNetwork = options.githubFetch !== undefined;
  // One for the life of this manager — one `mason run` — shared by every call,
  // so a tick that finds nothing changed costs no budget.
  const etags = createEtagCache();

  function channelOptions() {
    const now = (): number => Date.now();
    return {
      token: options.token,
      apiBase,
      requestRetries: testNetwork ? 0 : DEFAULT_REQUEST_RETRIES,
      deadlineMs: now() + options.durationMs,
      now,
      shouldInterrupt: () => options.interruptFlag.interrupted,
      throttle: !testNetwork,
      etags,
      ...(options.githubFetch !== undefined ? { fetch: options.githubFetch } : {}),
    };
  }

  const signalsResume = (payload: Record<string, unknown>): boolean =>
    payloadHasLabel(payload, resumeLabel);

  const clearResume = async (key: string): Promise<void> => {
    const issue = issueNumberFromExternalId(key);
    if (issue === undefined) {
      return;
    }
    const call = createClient(channelOptions());
    try {
      await call.request("DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}", {
        owner: options.repo.owner,
        repo: options.repo.name,
        issue_number: issue,
        name: resumeLabel,
      });
    } catch {
      // Already gone, or the label was never there. Either way there is
      // nothing left to take back.
    }
  };

  const report = async (input: ReportInput): Promise<boolean> => {
    // Every key this manager mints ends in `#<issue>`, so the Thread to write
    // on is recoverable without Host carrying an issue number around.
    const issue = issueNumberFromExternalId(input.key);
    if (issue === undefined) {
      return false;
    }
    const emitterInvocation: Parameters<typeof runEmitter>[0]["invocation"] = {
      repo: options.repo,
      issue,
      apiBase,
      event: input.event as GithubEventName,
      key: input.key,
      project: input.project,
      at: new Date().toISOString(),
      fields: input.fields,
      maxReportChars: MAX_REPORT_CHARS,
      defaultPriority,
      resumeLabel,
      durationMs: options.durationMs,
      requestRetries: testNetwork ? 0 : DEFAULT_REQUEST_RETRIES,
      dryRun: false,
    };
    if (input.eventId !== undefined) {
      emitterInvocation.eventId = input.eventId;
    }
    if (options.stateLabels !== undefined) {
      emitterInvocation.stateLabels = options.stateLabels;
    }
    const result = await runEmitter({
      invocation: emitterInvocation,
      github: createClient(channelOptions()),
      write: silent,
      interruptFlag: options.interruptFlag,
    });
    // A Thread that already carries this eventId has said it. Counting that
    // as failure made every poll re-ask and film report-declined forever.
    return result.outcome === "reported" || result.outcome === "duplicate";
  };

  const probe = async (key: string): Promise<ProbeResult> => {
    const issue = issueNumberFromExternalId(key);
    if (issue === undefined) {
      return "unavailable";
    }
    const now = (): number => Date.now();
    return await probeIssue({
      github: createClient(channelOptions()),
      repo: options.repo,
      number: issue,
      deadlineMs: now() + options.durationMs,
      now,
      shouldInterrupt: () => options.interruptFlag.interrupted,
    });
  };

  function submissionContext(): SubmissionContext {
    const now = (): number => Date.now();
    return {
      repo: options.repo,
      github: createClient(channelOptions()),
      deadlineMs: now() + options.durationMs,
      now,
      shouldInterrupt: () => options.interruptFlag.interrupted,
      keepBranch: options.keepBranch,
    };
  }

  /** Features: the top-level issues that carry the feature-ready label, whatever else they say. */
  const features: FeatureTrackerPort = {
    signalsResume,
    clearResume,
    probe,
    report,

    async listen(input): Promise<ListenResult> {
      const deliveries: ListenResult["deliveries"] = [];
      const alreadySettled = (payload: Record<string, unknown>): boolean =>
        options.stateLabels !== undefined &&
        settledAlready(payload, options.stateLabels, resumeLabel);
      const listenerInvocation: Parameters<typeof runListener>[0]["invocation"] = {
        manager: MANAGER,
        repo: options.repo,
        apiBase,
        state: "all",
        labels: [featureReadyLabel],
        follow: false,
        maxEvents: DEFAULT_MAX_EVENTS,
        durationMs: options.durationMs,
        perPage: DEFAULT_PER_PAGE,
        requestRetries: testNetwork ? 0 : DEFAULT_REQUEST_RETRIES,
      };
      if (input.since !== undefined) {
        listenerInvocation.since = input.since;
      }
      const listened = await runListener({
        invocation: listenerInvocation,
        github: createClient(channelOptions()),
        write: (line) => {
          if (
            line.event === "intention" &&
            typeof line.cursor === "string" &&
            isObject(line.payload)
          ) {
            if (!alreadySettled(line.payload)) {
              deliveries.push({ cursor: line.cursor, payload: line.payload });
            }
          }
        },
        interruptFlag: options.interruptFlag,
      });
      return { outcome: listened.outcome, deliveries };
    },

    async adapt(payload): Promise<AdaptResult> {
      const adapterInvocation: Parameters<typeof runAdapter>[0]["invocation"] = {
        manager: MANAGER,
        repo: options.repo,
        apiBase,
        defaultPriority,
        maxRawBytes: DEFAULT_MAX_RAW_BYTES,
        projectLabelPrefix: DEFAULT_PROJECT_LABEL_PREFIX,
        priorityLabelPrefix: DEFAULT_PRIORITY_LABEL_PREFIX,
        resumeLabel,
        mergeWhenReadyLabel,
        skipFeatureTestLabel,
        fetch: true,
        fetchDurationMs: options.durationMs,
        requestRetries: testNetwork ? 0 : DEFAULT_REQUEST_RETRIES,
      };
      if (options.defaultProject !== undefined) {
        adapterInvocation.defaultProject = options.defaultProject;
      }
      const adapted = await runAdapter({
        invocation: adapterInvocation,
        raw: JSON.stringify(payload),
        github: createClient(channelOptions()),
        write: silent,
        interruptFlag: options.interruptFlag,
      });
      if (adapted.outcome === "invalid" && adapted.invalid !== undefined) {
        return {
          outcome: "invalid",
          invalid: adapted.invalid,
          key: keyFromPayload(payload, options.repo),
          project: projectFromPayload(payload, options.defaultProject),
          fingerprint: writtenFingerprint(payload, options.stateLabels),
        };
      }
      if (adapted.outcome === "unavailable" || adapted.outcome === "interrupted") {
        return { outcome: adapted.outcome };
      }
      if (adapted.outcome !== "converted" || adapted.feature === undefined) {
        return { outcome: "unavailable" };
      }
      return { outcome: "converted", feature: adapted.feature };
    },
  };

  /** Tickets: the sub-issues of a Feature; the lines and Submissions: branches and pull requests. */
  const tickets: TicketTrackerPort = {
    clearResume,
    probe,
    report,

    async tickets(feature): Promise<TicketsResult> {
      const now = (): number => Date.now();
      return await listTickets({
        github: createClient(channelOptions()),
        repo: options.repo,
        manager: MANAGER,
        feature,
        defaultPriority,
        projectLabelPrefix: DEFAULT_PROJECT_LABEL_PREFIX,
        priorityLabelPrefix: DEFAULT_PRIORITY_LABEL_PREFIX,
        resumeLabel,
        ticketReadyLabel,
        featureTestLabel,
        deadlineMs: now() + options.durationMs,
        now,
        shouldInterrupt: () => options.interruptFlag.interrupted,
      });
    },

    async openLine(input): Promise<LineResult> {
      return await openLine(input, submissionContext());
    },

    async dropLine(line: string): Promise<void> {
      await dropLine(line, submissionContext());
    },

    async submit(input: SubmissionRequest): Promise<SubmissionResult> {
      return await submitPullRequest(input, submissionContext());
    },

    async behind(input: { reference: string }): Promise<BehindResult> {
      return await behindPullRequest(input.reference, submissionContext());
    },

    async fold(input: { reference: string }): Promise<FoldResult> {
      return await foldPullRequest(input.reference, submissionContext());
    },

    async settled(input: { reference: string }): Promise<SettledResult> {
      return await settledPullRequest(input.reference, submissionContext());
    },
  };

  return { features, tickets };
}

/**
 * Whether the tracker already says this Ticket is finished.
 *
 * The WorkLedger is the source of truth, and it is the only memory: lose it and
 * every open issue looks new, so finished work is built and offered a second
 * time. The state label is what the tracker remembers, and reading it back is
 * cheaper than rebuilding a Ticket that is already merged. The resume signal
 * overrides it, so a human still has a way to ask for more.
 */
function keyFromPayload(payload: Record<string, unknown>, repo: Repository): string {
  const number = issueNumberFromPayload(payload);
  return number === undefined
    ? `${MANAGER}:unconvertible`
    : `${MANAGER}:${repo.owner}/${repo.name}#${number}`;
}

function projectFromPayload(
  payload: Record<string, unknown>,
  defaultProject: string | undefined,
): string {
  const labels = payload.labels;
  if (Array.isArray(labels)) {
    for (const entry of labels) {
      const name =
        typeof entry === "string"
          ? entry
          : entry !== null && typeof entry === "object" && "name" in entry
            ? String((entry as { name?: unknown }).name ?? "")
            : "";
      const prefix = DEFAULT_PROJECT_LABEL_PREFIX;
      if (name.toLowerCase().startsWith(prefix.toLowerCase())) {
        const value = name.slice(prefix.length).trim();
        if (value.length > 0) {
          return value;
        }
      }
    }
  }
  return defaultProject ?? UNKNOWN_PROJECT;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
