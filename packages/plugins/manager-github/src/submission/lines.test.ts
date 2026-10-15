import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createClient } from "../github/client.js";
import { dropLine, openLine, settledPullRequest } from "./lines.js";
import type { SubmissionContext } from "./submission.js";

type Call = { method: string; path: string; body: Record<string, unknown> };

function contextOf(
  handler: (call: Call) => { status: number; body: unknown },
  calls: Call[] = [],
): SubmissionContext {
  const fetch = (async (input: unknown, init: { method?: string; body?: unknown } = {}) => {
    const call: Call = {
      method: String(init.method ?? "GET").toUpperCase(),
      // Octokit percent-encodes a ref's slashes; GitHub reads them either way.
      path: decodeURIComponent(new URL(String(input)).pathname),
      body: typeof init.body === "string" ? JSON.parse(init.body) : {},
    };
    calls.push(call);
    const answer = handler(call);
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  return {
    repo: { owner: "tilap", name: "mason" },
    github: createClient({
      token: "t",
      apiBase: "https://api.github.com",
      requestRetries: 0,
      deadlineMs: Date.now() + 10_000,
      fetch,
    }),
    deadlineMs: Date.now() + 10_000,
    now: () => Date.now(),
    shouldInterrupt: () => false,
  };
}

describe("openLine", () => {
  it("cuts the line from the head of the branch it comes from", async () => {
    const calls: Call[] = [];
    const context = contextOf(({ method, path }) => {
      if (method === "GET" && path === "/repos/tilap/mason/git/ref/heads/main") {
        return { status: 200, body: { object: { sha: "abc123" } } };
      }
      if (method === "POST" && path === "/repos/tilap/mason/git/refs") {
        return { status: 201, body: {} };
      }
      return { status: 404, body: {} };
    }, calls);
    assert.deepEqual(await openLine({ line: "feature/7", from: "main" }, context), {
      outcome: "opened",
    });
    assert.deepEqual(calls.at(-1)?.body, { ref: "refs/heads/feature/7", sha: "abc123" });
  });

  it("takes a line that already exists as done", async () => {
    const context = contextOf(({ method }) =>
      method === "GET"
        ? { status: 200, body: { object: { sha: "abc123" } } }
        : { status: 422, body: { message: "Reference already exists" } },
    );
    assert.deepEqual(await openLine({ line: "feature/7", from: "main" }, context), {
      outcome: "opened",
    });
  });

  it("refuses a branch to cut from that is not there, and waits out a failing API", async () => {
    const missing = contextOf(() => ({ status: 404, body: { message: "Not Found" } }));
    const refused = await openLine({ line: "feature/7", from: "nope" }, missing);
    assert.equal(refused.outcome, "refused");
    const down = contextOf(() => ({ status: 500, body: {} }));
    assert.deepEqual(await openLine({ line: "feature/7", from: "main" }, down), {
      outcome: "unavailable",
    });
  });
});

describe("dropLine", () => {
  it("deletes the branch, and says nothing when it cannot", async () => {
    const calls: Call[] = [];
    await dropLine(
      "feature/7",
      contextOf(() => ({ status: 204, body: {} }), calls),
    );
    assert.deepEqual(
      calls.map((call) => [call.method, call.path]),
      [["DELETE", "/repos/tilap/mason/git/refs/heads/feature/7"]],
    );
    await dropLine(
      "feature/7",
      contextOf(() => ({ status: 404, body: {} })),
    );
  });
});

describe("settledPullRequest", () => {
  const reference = "https://github.com/tilap/mason/pull/9";
  const answer = (body: unknown, status = 200) => contextOf(() => ({ status, body }));

  it("tells a merge from a closing from an open pull request", async () => {
    assert.equal(
      await settledPullRequest(reference, answer({ state: "closed", merged: true })),
      "folded",
    );
    assert.equal(
      await settledPullRequest(reference, answer({ state: "closed", merged: false })),
      "closed",
    );
    assert.equal(
      await settledPullRequest(reference, answer({ state: "open", merged: false })),
      "open",
    );
  });

  it("is unavailable when it cannot read, or the reference is not a pull request", async () => {
    assert.equal(await settledPullRequest(reference, answer({}, 500)), "unavailable");
    assert.equal(await settledPullRequest("pr-1", answer({})), "unavailable");
  });
});
