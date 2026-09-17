import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type ClientOptions, createClient, type GithubClient } from "../../github/client.js";
import { renderMarker } from "../thread/marker.js";
import type { Invocation } from "../types.js";
import { runEmitter } from "./run-emitter.js";

function invocation(overrides: Partial<Invocation> = {}): Invocation {
  return {
    repo: { owner: "tilap", name: "mason" },
    issue: 42,
    apiBase: "https://api.github.com",
    event: "accepted",
    key: "github:tilap/mason#42",
    project: "reporting",
    at: "2026-09-05T10:00:00.000Z",
    fields: { priority: 75 },
    maxReportChars: 8_000,
    durationMs: 5_000,
    requestRetries: 0,
    dryRun: false,
    ...overrides,
  };
}

/** One call as the fake network saw it. */
type Call = { method: string; url: string; body: Record<string, unknown> | undefined };

type Answer = { status: number; body?: unknown };
type Handler = (call: Call) => Answer | undefined;

/** A Target whose network is a function, so no test touches GitHub. */
function targetOf(
  handler: Handler = () => undefined,
  over: Partial<ClientOptions> = {},
): { github: GithubClient; calls: Call[] } {
  const calls: Call[] = [];
  const fetch = (async (input: unknown, init: { method?: string; body?: unknown } = {}) => {
    const call: Call = {
      method: String(init.method ?? "GET").toUpperCase(),
      url: String(input),
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const answer = handler(call) ?? defaultAnswer(call);
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;

  const github = createClient({
    token: "test-token",
    apiBase: "https://api.github.com",
    requestRetries: 0,
    deadlineMs: Date.now() + 10_000,
    fetch,
    // Writes are paced a second apart in a real run; no test is about that wait.
    throttle: false,
    ...over,
  });
  return { github, calls };
}

function defaultAnswer(call: Call): Answer {
  if (call.method === "POST" && call.url.endsWith("/comments")) {
    return {
      status: 201,
      body: { id: 1, html_url: "https://github.com/tilap/mason/issues/42#issuecomment-1" },
    };
  }
  return { status: 200, body: [] };
}

/** The Markdown a recorded POST would have appended. */
function commentBodyOf(call: Call | undefined): string {
  const body = call?.body?.body;
  return typeof body === "string" ? body : "";
}

function collect(): {
  write: (line: Record<string, unknown>) => void;
  lines: Record<string, unknown>[];
} {
  const lines: Record<string, unknown>[] = [];
  return { write: (line) => lines.push(line), lines };
}

describe("runEmitter", () => {
  it("appends one comment carrying the section and the record", async () => {
    const { github, calls } = targetOf();
    const { write, lines } = collect();

    const result = await runEmitter({ invocation: invocation(), github, write });

    assert.equal(result.outcome, "reported");
    assert.equal(result.exitCode, 0);
    assert.equal(result.thread, "tilap/mason#42");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.method, "POST");
    assert.equal(calls[0]?.url, "https://api.github.com/repos/tilap/mason/issues/42/comments");
    const body = commentBodyOf(calls[0]);
    assert.equal(body.includes("## Accepted"), true);
    assert.equal(body.includes("feature-event"), true);
    assert.equal(
      lines.at(-1)?.comment_url,
      "https://github.com/tilap/mason/issues/42#issuecomment-1",
    );
  });

  it("writes the exact bytes under --dry-run, and calls nothing", async () => {
    const { github, calls } = targetOf();
    const { write, lines } = collect();

    const dry = await runEmitter({ invocation: invocation({ dryRun: true }), github, write });
    const real = await runEmitter({ invocation: invocation(), github, write });

    assert.equal(dry.outcome, "rendered");
    assert.equal(dry.exitCode, 0);
    const previewed = lines.find((line) => line.event === "render")?.body;
    assert.equal(previewed, commentBodyOf(calls[0]));
    assert.equal(real.outcome, "reported");
  });

  it("reports a second time as duplicate when --event-id is already in the Thread", async () => {
    const marker = renderMarker({ event_id: "acc-42" });
    const { github, calls } = targetOf((call) =>
      call.method === "GET" ? { status: 200, body: [{ body: `x ${marker}` }] } : undefined,
    );
    const { write } = collect();

    const result = await runEmitter({
      invocation: invocation({ eventId: "acc-42" }),
      github,
      write,
    });

    assert.equal(result.outcome, "duplicate");
    assert.equal(result.exitCode, 0);
    assert.deepEqual(
      calls.map((call) => call.method),
      ["GET"],
    );
  });

  it("appends when --event-id is new", async () => {
    const { github, calls } = targetOf();
    const { write } = collect();

    const result = await runEmitter({
      invocation: invocation({ eventId: "acc-42" }),
      github,
      write,
    });

    assert.equal(result.outcome, "reported");
    assert.deepEqual(
      calls.map((call) => call.method),
      ["GET", "POST"],
    );
  });

  it("refuses to double-report when the Thread cannot be read", async () => {
    const { github } = targetOf((call) =>
      call.method === "GET" ? { status: 403, body: { message: "no" } } : undefined,
    );
    const { write } = collect();

    const result = await runEmitter({
      invocation: invocation({ eventId: "acc-42" }),
      github,
      write,
    });

    assert.equal(result.outcome, "unreportable");
    assert.equal(result.exitCode, 1);
  });

  it("is unreportable, with the API message, when the comment is refused", async () => {
    const { github } = targetOf((call) =>
      call.method === "POST" ? { status: 404, body: { message: "Not Found" } } : undefined,
    );
    const { write, lines } = collect();

    const result = await runEmitter({ invocation: invocation(), github, write });

    assert.equal(result.outcome, "unreportable");
    assert.equal(String(lines.at(-1)?.detail).includes("Not Found"), true);
  });

  it("moves the state label without touching anybody else's", async () => {
    const { github, calls } = targetOf((call) =>
      call.method === "GET" && call.url.includes("/labels")
        ? {
            status: 200,
            body: [
              { name: "mason:accepted" },
              { name: "mason:planned" },
              { name: "project:reporting" },
            ],
          }
        : undefined,
    );
    const { write, lines } = collect();

    const result = await runEmitter({
      invocation: invocation({
        event: "done",
        fields: { reference: "r1" },
        labelPrefix: "mason:",
      }),
      github,
      write,
    });

    assert.equal(result.outcome, "reported");
    const deleted = calls.filter((call) => call.method === "DELETE").map((call) => call.url);
    assert.deepEqual(deleted, [
      "https://api.github.com/repos/tilap/mason/issues/42/labels/mason%3Aaccepted",
      "https://api.github.com/repos/tilap/mason/issues/42/labels/mason%3Aplanned",
    ]);
    const added = calls.find((call) => call.method === "POST" && call.url.endsWith("/labels"));
    assert.deepEqual(added?.body, { labels: ["mason:done"] });
    assert.equal(lines.find((line) => line.event === "labels-finished")?.result, "moved");
  });

  it("stays reported when the label cannot be moved", async () => {
    const { github } = targetOf((call) =>
      call.url.includes("/labels") ? { status: 403, body: { message: "no" } } : undefined,
    );
    const { write, lines } = collect();

    const result = await runEmitter({
      invocation: invocation({ labelPrefix: "mason:" }),
      github,
      write,
    });

    assert.equal(result.outcome, "reported");
    assert.equal(lines.find((line) => line.event === "labels-finished")?.result, "unreportable");
  });

  it("stops on a signal before the comment, and writes nothing", async () => {
    const { github, calls } = targetOf();
    const { write } = collect();

    const result = await runEmitter({
      invocation: invocation(),
      github,
      write,
      interruptFlag: { interrupted: true },
    });

    assert.equal(result.outcome, "interrupted");
    assert.equal(result.exitCode, 130);
    assert.deepEqual(calls, []);
  });

  it("is unreportable when no channel was given for a real run", async () => {
    const { write } = collect();

    const result = await runEmitter({ invocation: invocation(), write });

    assert.equal(result.outcome, "unreportable");
  });
});
