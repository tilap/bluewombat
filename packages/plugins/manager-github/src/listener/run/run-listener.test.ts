import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { type ClientOptions, createClient, type GithubClient } from "../../github/client.js";
import { createEtagCache } from "../../github/etag-cache.js";
import type { Invocation } from "../types.js";
import { runListener } from "./run-listener.js";

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures");

function issue(number: number, updatedAt: string, extra: Record<string, unknown> = {}) {
  return { number, updated_at: updatedAt, title: `#${number}`, ...extra };
}

function invocation(overrides: Partial<Invocation> = {}): Invocation {
  return {
    manager: "github",
    repo: { owner: "tilap", name: "mason" },
    apiBase: "https://api.github.com",
    state: "all",
    labels: [],
    follow: false,
    maxEvents: 100,
    durationMs: 5_000,
    perPage: 100,
    requestRetries: 2,
    ...overrides,
  };
}

type Answer = { status: number; body?: unknown; headers?: Record<string, string> };

/** A channel whose network is a function, so no test touches GitHub. */
function channelOf(
  answer: (url: string) => Answer,
  over: Partial<ClientOptions> = {},
): { github: GithubClient; urls: string[] } {
  const urls: string[] = [];
  const fetch = (async (input: unknown): Promise<Response> => {
    const url = String(input);
    urls.push(url);
    const given = answer(url);
    return new Response(given.body === undefined ? null : JSON.stringify(given.body), {
      status: given.status,
      headers: { "content-type": "application/json", ...given.headers },
    });
  }) as unknown as typeof globalThis.fetch;

  const github = createClient({
    token: "test-token",
    apiBase: "https://api.github.com",
    requestRetries: 0,
    deadlineMs: Date.now() + 10_000,
    fetch,
    ...over,
  });
  return { github, urls };
}

/** A Source that answers a page at a time. */
function sourceOf(pages: unknown[][]): { github: GithubClient; urls: string[] } {
  return channelOf((url) => {
    const page = Number(new URL(url).searchParams.get("page") ?? "1");
    return { status: 200, body: pages[page - 1] ?? [] };
  });
}

function collect(): {
  write: (line: Record<string, unknown>) => void;
  lines: Record<string, unknown>[];
} {
  const lines: Record<string, unknown>[] = [];
  return { write: (line) => lines.push(line), lines };
}

function ofEvent(lines: Record<string, unknown>[], event: string): Record<string, unknown>[] {
  return lines.filter((line) => line.event === event);
}

const three = [
  issue(1, "2026-09-05T10:00:00Z"),
  issue(3, "2026-09-05T12:00:00Z"),
  issue(2, "2026-09-05T11:00:00Z"),
];

describe("runListener", () => {
  it("delivers every issue in Cursor order and ends on the last one", async () => {
    const { github } = sourceOf([three]);
    const { write, lines } = collect();

    const result = await runListener({ invocation: invocation(), github, write });

    assert.equal(result.outcome, "completed");
    assert.equal(result.stopReason, "drained");
    assert.equal(result.exitCode, 0);
    assert.deepEqual(
      ofEvent(lines, "intention").map((line) => line.cursor),
      ["2026-09-05T10:00:00Z#1", "2026-09-05T11:00:00Z#2", "2026-09-05T12:00:00Z#3"],
    );
    assert.equal(result.cursor, "2026-09-05T12:00:00Z#3");
  });

  it("passes the payload through, keys and all", async () => {
    const { github } = sourceOf([[issue(1, "2026-09-05T10:00:00Z", { unknown_field: [1, 2] })]]);
    const { write, lines } = collect();

    await runListener({ invocation: invocation(), github, write });

    const delivered = ofEvent(lines, "intention")[0]?.payload as Record<string, unknown>;
    assert.deepEqual(delivered.unknown_field, [1, 2]);
  });

  it("resumes strictly after --since, and asks the Source for that instant", async () => {
    const { github, urls } = sourceOf([three]);
    const { write, lines } = collect();

    const result = await runListener({
      invocation: invocation({ since: "2026-09-05T11:00:00Z#2" }),
      github,
      write,
    });

    assert.deepEqual(
      ofEvent(lines, "intention").map((line) => line.cursor),
      ["2026-09-05T12:00:00Z#3"],
    );
    assert.equal(new URL(urls[0] ?? "").searchParams.get("since"), "2026-09-05T11:00:00Z");
    assert.equal(result.delivered, 1);
  });

  it("never delivers a pull request", async () => {
    const { github } = sourceOf([
      [
        issue(1, "2026-09-05T10:00:00Z", { pull_request: { url: "…" } }),
        issue(2, "2026-09-05T11:00:00Z"),
      ],
    ]);
    const { write, lines } = collect();

    const result = await runListener({ invocation: invocation(), github, write });

    assert.equal(result.delivered, 1);
    assert.equal(result.skipped, 0);
    assert.equal(ofEvent(lines, "intention")[0]?.cursor, "2026-09-05T11:00:00Z#2");
  });

  it("reports a malformed entry and still completes", async () => {
    const { github } = sourceOf([["nonsense", issue(2, "2026-09-05T11:00:00Z")]]);
    const { write, lines } = collect();

    const result = await runListener({ invocation: invocation(), github, write });

    assert.equal(result.outcome, "completed");
    assert.equal(result.skipped, 1);
    assert.equal(ofEvent(lines, "skipped")[0]?.reason, "not-object");
    assert.equal(result.cursor, "2026-09-05T11:00:00Z#2");
  });

  it("stops on --max-events, Cursor on the last Delivery", async () => {
    const { github } = sourceOf([three]);
    const { write, lines } = collect();

    const result = await runListener({ invocation: invocation({ maxEvents: 2 }), github, write });

    assert.equal(result.stopReason, "max-events");
    assert.equal(ofEvent(lines, "intention").length, 2);
    assert.equal(result.cursor, "2026-09-05T11:00:00Z#2");
  });

  it("walks every page until a short one", async () => {
    const { github, urls } = sourceOf([
      [issue(1, "2026-09-05T10:00:00Z"), issue(2, "2026-09-05T11:00:00Z")],
      [issue(3, "2026-09-05T12:00:00Z")],
    ]);
    const { write } = collect();

    const result = await runListener({ invocation: invocation({ perPage: 2 }), github, write });

    assert.equal(result.delivered, 3);
    assert.equal(result.pages, 2);
    assert.deepEqual(
      urls.map((url) => new URL(url).searchParams.get("page")),
      ["1", "2"],
    );
  });

  it("carries the label filter and the state to the Source", async () => {
    const { github, urls } = sourceOf([[]]);
    const { write } = collect();

    await runListener({
      invocation: invocation({ labels: ["mason", "ready"], state: "open" }),
      github,
      write,
    });

    const query = new URL(urls[0] ?? "").searchParams;
    assert.equal(query.get("labels"), "mason,ready");
    assert.equal(query.get("state"), "open");
    assert.equal(query.get("sort"), "updated");
    assert.equal(query.get("direction"), "asc");
  });

  it("ends source-lost when the Source refuses", async () => {
    const { github } = channelOf(() => ({ status: 404, body: { message: "Not Found" } }));
    const { write, lines } = collect();

    const result = await runListener({ invocation: invocation(), github, write });

    assert.equal(result.outcome, "source-lost");
    assert.equal(result.exitCode, 1);
    assert.equal(String(ofEvent(lines, "run-finished")[0]?.detail).includes("Not Found"), true);
  });

  it("waits out a rate limit and then delivers", async () => {
    let calls = 0;
    const { github } = channelOf(
      () => {
        calls += 1;
        if (calls === 1) {
          return {
            status: 403,
            headers: { "x-ratelimit-remaining": "0", "retry-after": "0" },
            body: { message: "API rate limit exceeded" },
          };
        }
        return { status: 200, body: [issue(1, "2026-09-05T10:00:00Z")] };
      },
      { requestRetries: 1 },
    );
    const { write } = collect();

    const result = await runListener({ invocation: invocation(), github, write });

    assert.equal(result.outcome, "completed");
    assert.equal(result.delivered, 1);
    assert.equal(calls, 2);
  });

  it("gives up source-lost once the retries are spent", async () => {
    let calls = 0;
    const { github } = channelOf(
      () => {
        calls += 1;
        return { status: 500, body: { message: "boom" } };
      },
      { requestRetries: 1 },
    );
    const { write } = collect();

    const result = await runListener({
      invocation: invocation({ requestRetries: 1 }),
      github,
      write,
    });

    assert.equal(result.outcome, "source-lost");
    assert.equal(calls, 2);
  });

  it("stops on a signal before the next Delivery", async () => {
    const interruptFlag = { interrupted: false };
    const { github } = channelOf(() => {
      interruptFlag.interrupted = true;
      return { status: 200, body: three };
    });
    const { write } = collect();

    const result = await runListener({ invocation: invocation(), github, write, interruptFlag });

    assert.equal(result.outcome, "interrupted");
    assert.equal(result.exitCode, 130);
    assert.equal(result.delivered, 0);
  });

  it("runs --on-intention once per Delivery, and a failing hook changes nothing", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "feature-listener-github-"));
    const log = join(logDir, "hook.log");
    try {
      const { github } = sourceOf([[issue(1, "2026-09-05T10:00:00Z")]]);
      const { write } = collect();
      process.env.ON_INTENTION_LOG = log;

      const logged = await runListener({
        invocation: invocation({
          onIntentionArgv: ["node", join(fixturesDir, "on-intention-log.mjs")],
        }),
        github,
        write,
      });
      assert.equal(logged.outcome, "completed");
      assert.equal(readFileSync(log, "utf8").includes("--cursor 2026-09-05T10:00:00Z#1"), true);

      const { github: second } = sourceOf([[issue(1, "2026-09-05T10:00:00Z")]]);
      const failed = await runListener({
        invocation: invocation({
          onIntentionArgv: ["node", join(fixturesDir, "on-intention-fail.mjs")],
        }),
        github: second,
        write,
      });
      assert.equal(failed.outcome, "completed");
      assert.equal(failed.cursor, "2026-09-05T10:00:00Z#1");
    } finally {
      process.env.ON_INTENTION_LOG = undefined;
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  it("keeps scanning under --follow until the duration is spent", async () => {
    let calls = 0;
    const { github } = channelOf(() => {
      calls += 1;
      return { status: 200, body: calls === 1 ? [] : [issue(1, "2026-09-05T10:00:00Z")] };
    });
    const { write, lines } = collect();

    const result = await runListener({
      invocation: invocation({ follow: true, pollIntervalMs: 5, maxEvents: 1, durationMs: 2_000 }),
      github,
      write,
    });

    assert.equal(result.outcome, "completed");
    assert.equal(result.stopReason, "max-events");
    assert.equal(ofEvent(lines, "intention").length, 1);
    assert.ok(result.scans >= 2);
  });
});

describe("runListener with conditional reads", () => {
  it("delivers a page again after a 304 when the Cursor did not move", async () => {
    // Host did not commit the Cursor (a tick stopped midway): the same listing
    // is asked again, GitHub says nothing changed, and the issues not consumed
    // yet must come back, not vanish behind the 304.
    const statuses: number[] = [];
    const fetch = (async (_input: unknown, init: { headers?: unknown } = {}) => {
      const named = new Headers(init.headers as ConstructorParameters<typeof Headers>[0]).get(
        "if-none-match",
      );
      const status = named === '"v1"' ? 304 : 200;
      statuses.push(status);
      return status === 304
        ? new Response(null, { status, headers: { etag: '"v1"' } })
        : new Response(JSON.stringify([issue(7, "2026-10-04T10:00:00Z")]), {
            status,
            headers: { "content-type": "application/json", etag: '"v1"' },
          });
    }) as unknown as typeof globalThis.fetch;
    const github = createClient({
      token: "t",
      apiBase: "https://api.github.com",
      requestRetries: 0,
      deadlineMs: Date.now() + 10_000,
      fetch,
      throttle: false,
      etags: createEtagCache(),
    });

    const first = await runListener({ invocation: invocation(), github, write: () => {} });
    const again = await runListener({ invocation: invocation(), github, write: () => {} });

    assert.deepEqual(statuses, [200, 304]);
    assert.equal(first.delivered, 1);
    assert.equal(again.outcome, "completed");
    assert.equal(again.delivered, 1);
  });
});
