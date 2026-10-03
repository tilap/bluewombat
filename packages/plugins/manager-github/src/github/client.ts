/**
 * The one effect this package has on the outside world: HTTPS requests to the
 * GitHub REST API, authenticated by a token.
 *
 * The transport is `@octokit/core` with its retry and throttling plugins — not
 * a hand-written HTTP client. What lives here is only what this package owes on
 * top of it: a token in one place, the wait budget of one invocation, and the
 * mapping from a failure to this package's own vocabulary.
 */

import { Octokit } from "@octokit/core";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";

const GithubOctokit = Octokit.plugin(retry, throttling);

/**
 * How long one attempt may wait for GitHub to answer. Past it the attempt is a
 * transport failure, which the retry plugin tries again. Without it, the only
 * bound was the whole invocation's: a connection that went silent held a
 * report — and the work waiting on it — for minutes.
 */
export const REQUEST_TIMEOUT_MS = 30_000;

/** The authenticated channel. Injected, so a run is testable with no network. */
export type GithubClient = InstanceType<typeof GithubOctokit>;

/** Identifies the caller to GitHub; the API rejects a request without one. */
export const USER_AGENT = "bluewombat-manager-github";

export type ClientOptions = {
  /** The token lives here and nowhere else: not in an Invocation, not in a line. */
  token: string;
  apiBase: string;
  /** Extra attempts after the first, on a transport failure, a 5xx, or a rate limit. */
  requestRetries: number;
  /** Absolute time no wait may run past. */
  deadlineMs: number;
  now?: () => number;
  shouldInterrupt?: () => boolean;
  /** Replaces the network in tests. */
  fetch?: typeof globalThis.fetch;
  /** One attempt's wait for an answer. Default {@link REQUEST_TIMEOUT_MS}. */
  requestTimeoutMs?: number;
  /**
   * Space writes out the way GitHub asks, and wait out a rate limit. On by
   * default. Turning it off is a test seam: it also gives up the waiting, so a
   * real run must leave it alone.
   */
  throttle?: boolean;
};

/**
 * Build the channel. Retrying a 5xx and honouring a rate limit are the
 * plugins'; deciding that a wait would outlive this invocation is ours, because
 * only this package knows what the duration budget promised.
 */
export function createClient(options: ClientOptions): GithubClient {
  const now = options.now ?? (() => Date.now());
  const shouldInterrupt = options.shouldInterrupt ?? (() => false);

  const mayWait = (retryAfterSeconds: number, retryCount: number): boolean => {
    if (shouldInterrupt() || retryCount >= options.requestRetries) {
      return false;
    }
    return now() + retryAfterSeconds * 1_000 < options.deadlineMs;
  };

  return new GithubOctokit({
    auth: options.token,
    baseUrl: trimBase(options.apiBase),
    userAgent: USER_AGENT,
    retry: { retries: options.requestRetries },
    throttle: {
      enabled: options.throttle ?? true,
      onRateLimit: (retryAfter, _options, _octokit, retryCount) => mayWait(retryAfter, retryCount),
      onSecondaryRateLimit: (retryAfter, _options, _octokit, retryCount) =>
        mayWait(retryAfter, retryCount),
    },
    request: {
      fetch: boundedFetch(
        options.fetch ?? globalThis.fetch,
        options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
      ),
    },
  });
}

/**
 * Each attempt gets its own clock, on top of whatever bound the caller set.
 *
 * Run out, it fails the way a dropped connection does: the request layer
 * passes an abort through untouched and the retry plugin only retries what that
 * layer wrapped. A caller's own abort — the deadline, an interrupt — stays an
 * abort, and is not retried.
 */
function boundedFetch(base: typeof globalThis.fetch, timeoutMs: number): typeof globalThis.fetch {
  return async (input, init = {}) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    try {
      return await base(input, { ...init, signal });
    } catch (error) {
      if (timeout.aborted && init.signal?.aborted !== true) {
        throw new TypeError("fetch failed", {
          cause: new Error(`GitHub did not answer within ${timeoutMs} ms`),
        });
      }
      throw error;
    }
  };
}

export function trimBase(apiBase: string): string {
  return apiBase.replace(/\/+$/, "");
}

export type Failure = {
  /** A refusal that will not change on a retry: a 404 does not become a 200. */
  permanent: boolean;
  status?: number;
  detail: string;
};

const DETAIL_LIMIT = 512;

/**
 * Read what went wrong. Anything that reached here already exhausted the
 * plugins' retries, so the question left is only whether retrying *later*
 * could help.
 */
export function readFailure(error: unknown): Failure {
  const status = statusOf(error);
  const detail = truncate(messageOf(error));

  if (status === undefined) {
    return { permanent: false, detail };
  }
  if (status === 429 || (status === 403 && rateLimitSpent(error))) {
    return { permanent: false, status, detail: `Rate limited (${status}). ${detail}`.trim() };
  }
  if (status >= 500) {
    return { permanent: false, status, detail };
  }
  return { permanent: true, status, detail };
}

/** A 403 with the budget spent is a wait the invocation declined, not a refusal. */
function rateLimitSpent(error: unknown): boolean {
  const headers = (error as { response?: { headers?: Record<string, unknown> } } | null)?.response
    ?.headers;
  return headers?.["x-ratelimit-remaining"] === "0";
}

function statusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(text: string): string {
  return text.length <= DETAIL_LIMIT ? text : `${text.slice(0, DETAIL_LIMIT)}…[truncated]`;
}

export type Call = {
  /** Aborts on the duration clock, and on a stop signal. */
  signal: AbortSignal;
  /** Always call it: the interrupt poll would otherwise hold the process open. */
  release: () => void;
};

/** The bound every single request runs under. */
export function callSignal(
  deadlineMs: number,
  now: () => number,
  shouldInterrupt: () => boolean,
): Call {
  const controller = new AbortController();
  const poll = setInterval(() => {
    if (shouldInterrupt()) {
      controller.abort();
    }
  }, 20);
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(Math.max(1, deadlineMs - now())),
  ]);
  return { signal, release: () => clearInterval(poll) };
}
