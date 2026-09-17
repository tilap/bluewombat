import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type ClientOptions, createClient, type GithubClient } from "../../github/client.js";
import type { Invocation } from "../types.js";
import { runAdapter } from "./run-adapter.js";

function invocation(overrides: Partial<Invocation> = {}): Invocation {
  return {
    manager: "github",
    repo: { owner: "tilap", name: "mason" },
    apiBase: "https://api.github.com",
    defaultPriority: 50,
    maxRawBytes: 65_536,
    projectLabelPrefix: "project:",
    priorityLabelPrefix: "priority:",
    readyLabel: "ready",
    fetch: false,
    requestRetries: 0,
    at: "2026-09-05T10:00:00.000Z",
    ...overrides,
  };
}

const complete = {
  number: 42,
  title: "Add the export button",
  body: "Users need a CSV export.",
  state: "open",
  labels: ["project:reporting"],
};

function collect(): {
  write: (line: Record<string, unknown>) => void;
  lines: Record<string, unknown>[];
} {
  const lines: Record<string, unknown>[] = [];
  return { write: (line) => lines.push(line), lines };
}

/** A channel whose network is a function, so no test touches GitHub. */
function channelOf(
  response: { status: number; body: unknown },
  over: Partial<ClientOptions> = {},
): { github: GithubClient; urls: string[] } {
  const urls: string[] = [];
  const fetch = (async (input: unknown): Promise<Response> => {
    urls.push(String(input));
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "content-type": "application/json" },
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

describe("runAdapter", () => {
  it("converts a complete issue and names it after the repository", async () => {
    const { write, lines } = collect();

    const result = await runAdapter({
      invocation: invocation(),
      raw: JSON.stringify(complete),
      write,
    });

    assert.equal(result.outcome, "converted");
    assert.equal(result.exitCode, 0);
    assert.equal(result.feature?.key, "github:tilap/mason#42");
    assert.equal(lines.at(-1)?.outcome, "converted");
  });

  it("reads the envelope a repository sends about an issue", async () => {
    const { write } = collect();

    const result = await runAdapter({
      invocation: invocation(),
      raw: JSON.stringify({
        action: "labeled",
        issue: { ...complete, labels: ["project:p", "ready"] },
      }),
      write,
    });

    assert.equal(result.feature?.intent, "ready");
  });

  it("is a verdict, not a crash, when the issue cannot be converted", async () => {
    const { write, lines } = collect();

    const result = await runAdapter({
      invocation: invocation(),
      raw: JSON.stringify({ ...complete, body: null, title: null }),
      write,
    });

    assert.equal(result.outcome, "invalid");
    assert.equal(result.exitCode, 1);
    assert.equal(lines.at(-1)?.code, "missing-intention");
  });

  it("refuses a raw intention over the ceiling, and asks the API nothing", async () => {
    const { github, urls } = channelOf({ status: 200, body: complete });
    const { write } = collect();

    const result = await runAdapter({
      invocation: invocation({ maxRawBytes: 10, fetch: true, fetchDurationMs: 5_000 }),
      raw: JSON.stringify(complete),
      github,
      write,
    });

    assert.equal(result.invalid?.code, "raw-too-large");
    assert.deepEqual(urls, []);
  });

  it("completes a thin notification from the Fetch, and the raw intention still wins", async () => {
    const { github, urls } = channelOf({
      status: 200,
      body: { ...complete, title: "From the API", state: "open" },
    });
    const { write, lines } = collect();

    const result = await runAdapter({
      invocation: invocation({ fetch: true, fetchDurationMs: 5_000 }),
      raw: JSON.stringify({ number: 42, title: "From the notification" }),
      github,
      write,
    });

    assert.equal(result.outcome, "converted");
    assert.equal(result.feature?.title, "From the notification");
    assert.equal(result.feature?.intention, "Users need a CSV export.");
    assert.deepEqual(urls, ["https://api.github.com/repos/tilap/mason/issues/42"]);
    assert.equal(lines[0]?.event, "fetch-finished");
  });

  it("is unavailable, never invalid, when the Fetch does not answer", async () => {
    const { github } = channelOf({ status: 500, body: { message: "boom" } });
    const { write } = collect();

    const result = await runAdapter({
      invocation: invocation({ fetch: true, fetchDurationMs: 5_000 }),
      raw: JSON.stringify({ number: 42 }),
      github,
      write,
    });

    assert.equal(result.outcome, "unavailable");
    assert.equal(result.exitCode, 3);
  });

  it("is unavailable when a Fetch was asked for with no channel to make it", async () => {
    const { write } = collect();

    const result = await runAdapter({
      invocation: invocation({ fetch: true, fetchDurationMs: 5_000 }),
      raw: JSON.stringify({ number: 42 }),
      write,
    });

    assert.equal(result.outcome, "unavailable");
  });

  it("stops on a signal without writing a partial FeatureStandard", async () => {
    const { write, lines } = collect();

    const result = await runAdapter({
      invocation: invocation(),
      raw: JSON.stringify(complete),
      write,
      interruptFlag: { interrupted: true },
    });

    assert.equal(result.outcome, "interrupted");
    assert.equal(result.exitCode, 130);
    assert.equal(
      lines.some((line) => line.feature !== undefined),
      false,
    );
  });
});
