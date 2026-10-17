import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createClient } from "../github/client.js";
import { listTickets } from "./list-tickets.js";

type Routes = Record<string, { status?: number; body: unknown | ((url: URL) => unknown) }>;

function requestOf(routes: Routes, urls: string[] = []) {
  const fetch = (async (input: unknown): Promise<Response> => {
    const url = new URL(String(input));
    urls.push(`${url.pathname}${url.search}`);
    const route = routes[url.pathname];
    if (route === undefined) {
      return new Response("{}", { status: 404 });
    }
    const body = typeof route.body === "function" ? route.body(url) : route.body;
    return new Response(JSON.stringify(body), {
      status: route.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  return {
    github: createClient({
      token: "t",
      apiBase: "https://api.github.com",
      requestRetries: 0,
      deadlineMs: Date.now() + 10_000,
      fetch,
    }),
    feature: { key: "github:tilap/mason#10", external_id: "tilap/mason#10", project: "app" },
    repo: { owner: "tilap", name: "mason" },
    manager: "github",
    defaultPriority: 50,
    projectLabelPrefix: "project:",
    priorityLabelPrefix: "priority:",
    resumeLabel: "to-resume",
    ticketReadyLabel: "task-ready",
    noTestsLabel: "no-tests",
    deadlineMs: Date.now() + 10_000,
    now: () => Date.now(),
    shouldInterrupt: () => false,
  };
}

const issue = (number: number, over: Record<string, unknown> = {}) => ({
  number,
  title: `Ticket ${number}`,
  body: `Do ${number}.`,
  state: "open",
  labels: [{ name: "task-ready" }],
  html_url: `https://github.com/tilap/mason/issues/${number}`,
  updated_at: "2026-10-01T00:00:00Z",
  ...over,
});

const SUBS = "/repos/tilap/mason/issues/10/sub_issues";
const blockedBy = (number: number) => `/repos/tilap/mason/issues/${number}/dependencies/blocked_by`;

describe("listTickets", () => {
  it("lists the sub-issues, what blocks each, and the signals they carry", async () => {
    const request = requestOf({
      [SUBS]: {
        body: [
          issue(11, { labels: [{ name: "task-ready" }, { name: "priority:high" }] }),
          issue(12, { labels: [], state: "closed" }),
          issue(13, { labels: [{ name: "task-ready" }, { name: "to-resume" }] }),
          issue(14, { pull_request: {} }),
        ],
      },
      [blockedBy(11)]: { body: [issue(12), issue(13)] },
      [blockedBy(12)]: { body: [] },
      [blockedBy(13)]: { body: [] },
    });
    const result = await listTickets(request);
    assert.equal(result.outcome, "listed");
    if (result.outcome !== "listed") {
      return;
    }
    assert.deepEqual(
      result.tickets.map((entry) => [entry.ticket.key, entry.task_ready, entry.resume, entry.open]),
      [
        ["github:tilap/mason#11", true, false, true],
        ["github:tilap/mason#12", false, false, false],
        ["github:tilap/mason#13", true, true, true],
      ],
    );
    const first = result.tickets[0]?.ticket;
    assert.deepEqual(first?.blocked_by, ["github:tilap/mason#12", "github:tilap/mason#13"]);
    assert.equal(first?.priority, 75);
    assert.equal(first?.intention, "Do 11.");
    assert.equal(first?.title, "Ticket 11");
    assert.equal(first?.external_id, "tilap/mason#11");
    // The Feature's Project, whatever the Ticket's own labels say.
    assert.equal(first?.project, "app");
  });

  it("reads the Ticket label from the configuration, shared name included", async () => {
    const request = {
      ...requestOf({
        [SUBS]: {
          body: [
            issue(11, { labels: [{ name: "ready-for-agent" }] }),
            issue(12, { labels: [{ name: "task-ready" }] }),
          ],
        },
        [blockedBy(11)]: { body: [] },
        [blockedBy(12)]: { body: [] },
      }),
      ticketReadyLabel: "ready-for-agent",
    };
    const result = await listTickets(request);
    assert.equal(result.outcome, "listed");
    if (result.outcome !== "listed") {
      return;
    }
    assert.deepEqual(
      result.tickets.map((entry) => [entry.ticket.key, entry.task_ready]),
      [
        ["github:tilap/mason#11", true],
        ["github:tilap/mason#12", false],
      ],
    );
  });

  it("reads every page of a long list", async () => {
    const urls: string[] = [];
    const many = Array.from({ length: 100 }, (_, at) => issue(100 + at));
    const request = requestOf(
      {
        [SUBS]: { body: (url: URL) => (url.searchParams.get("page") === "1" ? many : []) },
        ...Object.fromEntries(many.map((one) => [blockedBy(Number(one.number)), { body: [] }])),
      },
      urls,
    );
    const result = await listTickets(request);
    assert.equal(result.outcome, "listed");
    assert.equal(result.outcome === "listed" ? result.tickets.length : 0, 100);
    assert.ok(urls.some((url) => url.includes("sub_issues") && url.includes("page=2")));
  });

  it("is unavailable, never an empty list, when GitHub does not answer", async () => {
    const request = requestOf({ [SUBS]: { status: 500, body: { message: "boom" } } });
    assert.deepEqual(await listTickets(request), { outcome: "unavailable" });
    const noBlockers = requestOf({
      [SUBS]: { body: [issue(11)] },
      [blockedBy(11)]: { status: 500, body: {} },
    });
    assert.deepEqual(await listTickets(noBlockers), { outcome: "unavailable" });
  });

  it("is interrupted when the stop flag is up", async () => {
    const request = {
      ...requestOf({ [SUBS]: { status: 500, body: {} } }),
      shouldInterrupt: () => true,
    };
    assert.deepEqual(await listTickets(request), { outcome: "interrupted" });
  });

  it("is unavailable for a key that names no issue", async () => {
    const request = requestOf({});
    assert.deepEqual(
      await listTickets({
        ...request,
        feature: { ...request.feature, key: "github:unconvertible" },
      }),
      { outcome: "unavailable" },
    );
  });

  it("reads the no-tests label beside the words, under whatever name the config gave it", async () => {
    const routes = {
      [SUBS]: {
        body: [
          issue(11, { labels: [{ name: "task-ready" }, { name: "No-Tests" }] }),
          issue(12, { labels: [{ name: "task-ready" }] }),
          issue(13, { labels: [{ name: "task-ready" }, { name: "sans-tests" }] }),
        ],
      },
      [blockedBy(11)]: { body: [] },
      [blockedBy(12)]: { body: [] },
      [blockedBy(13)]: { body: [] },
    };
    const flags = async (request: Awaited<ReturnType<typeof requestOf>>) => {
      const result = await listTickets(request);
      assert.equal(result.outcome, "listed");
      return result.outcome === "listed" ? result.tickets.map((entry) => entry.no_tests) : [];
    };
    // The default name, compared without case.
    assert.deepEqual(await flags(requestOf(routes)), [true, false, false]);
    // Another name: only that one counts.
    assert.deepEqual(await flags({ ...requestOf(routes), noTestsLabel: "sans-tests" }), [
      false,
      false,
      true,
    ]);
  });
});
