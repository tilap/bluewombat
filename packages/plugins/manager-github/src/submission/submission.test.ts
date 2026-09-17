import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createClient } from "../github/client.js";
import { bodyOf, commitOf, foldPullRequest, submitPullRequest, titleOf } from "./submission.js";

const KEY = "github:tilap/mason#7";
const REPO = { owner: "tilap", name: "mason" };

type Call = { method: string; path: string; body: Record<string, unknown> };

function githubOf(openPulls: { number: number; head: { sha: string } }[]): {
  context: Parameters<typeof submitPullRequest>[1];
  calls: Call[];
} {
  const calls: Call[] = [];
  const handler = (async (input: unknown, init: { method?: string; body?: unknown } = {}) => {
    const method = String(init.method ?? "GET").toUpperCase();
    // Octokit percent-encodes a ref's slashes; GitHub reads them either way.
    const path = decodeURIComponent(new URL(String(input)).pathname);
    const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
    calls.push({ method, path, body });
    if (method === "GET" && path === "/repos/tilap/mason/pulls") {
      return json(200, openPulls);
    }
    if (method === "POST" && path === "/repos/tilap/mason/pulls") {
      return json(201, { number: 12 });
    }
    if (method === "GET" && path === "/repos/tilap/mason/pulls/12") {
      return json(200, {
        number: 12,
        title: "Add slugify (#7)",
        body: "What it does.\n\nCloses #7\n\n<!-- commit-message\nAdd slugify (#7)\n\nWhat it does.\n-->",
        head: { ref: "issue/7" },
      });
    }
    if (method === "PUT" && path === "/repos/tilap/mason/pulls/12/merge") {
      return json(200, { merged: true, sha: "9aeff612f47153162c4b73b90cae5ec767230b3d" });
    }
    if (method === "DELETE" && path === "/repos/tilap/mason/git/refs/heads/issue/7") {
      return json(204, {});
    }
    return json(404, { message: `No fixture for ${method} ${path}` });
  }) as unknown as typeof globalThis.fetch;
  const now = (): number => Date.now();
  return {
    calls,
    context: {
      repo: REPO,
      github: createClient({
        token: "t",
        apiBase: "https://api.github.com",
        requestRetries: 0,
        deadlineMs: now() + 10_000,
        now,
        shouldInterrupt: () => false,
        throttle: false,
        fetch: handler,
      }),
      deadlineMs: now() + 10_000,
      now,
      shouldInterrupt: () => false,
    },
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("titleOf", () => {
  it("drops the trailing full stop and names the issue", () => {
    assert.equal(
      titleOf({ key: KEY, title: "Add a `slugify` helper." }),
      "Add a `slugify` helper (#7)",
    );
    assert.equal(titleOf({ key: KEY, title: "  Add slugify  " }), "Add slugify (#7)");
  });

  it("falls back to the key when there is no title", () => {
    assert.equal(titleOf({ key: KEY }), "mason github:tilap/mason#7 (#7)");
  });
});

describe("bodyOf", () => {
  it("says what was asked, what changed, and closes the issue", () => {
    const body = bodyOf({
      key: KEY,
      title: "Add slugify",
      intention: "A slug helper.",
      steps: ["Add slugify with its tests", "Document it"],
    });
    assert.equal(
      body,
      [
        "A slug helper.",
        "",
        "## Changes",
        "1. Add slugify with its tests",
        "2. Document it",
        "",
        "Closes #7",
        "",
        "<!-- commit-message",
        "Add slugify (#7)",
        "",
        "A slug helper.",
        "-->",
      ].join("\n"),
    );
  });

  it("folds with the human's title and words by default, and the slot's when there was one", () => {
    const plain = bodyOf({ key: KEY, title: "Add slugify", intention: "A slug helper." });
    assert.deepEqual(commitOf("Add slugify (#7)", plain), {
      commit_title: "Add slugify (#7)",
      commit_message: "A slug helper.\n\nCloses #7",
    });

    const guided = bodyOf({
      key: KEY,
      title: "Add slugify",
      intention: "A slug helper.",
      description: { subject: "feat(text): add slugify", body: "Because titles need URLs." },
    });
    // The slot's body is what the reader of the pull request sees too.
    assert.match(guided, /^Because titles need URLs\./);
    assert.doesNotMatch(guided, /^A slug helper\./m);
    assert.deepEqual(commitOf("Add slugify (#7)", guided), {
      commit_title: "feat(text): add slugify",
      commit_message: "Because titles need URLs.\n\nCloses #7",
    });

    // A pull request nobody of ours opened: its title, and the closing line.
    assert.deepEqual(commitOf("Theirs", "Some text\n\nCloses #3"), {
      commit_title: "Theirs",
      commit_message: "Closes #3",
    });
  });

  it("never says who opened it, and skips what it does not have", () => {
    const body = bodyOf({ key: KEY, title: "Just this", intention: "Just this." });
    assert.match(body, /^Just this\.\n\nCloses #7\n\n<!-- commit-message\n/);
    assert.doesNotMatch(body, /mason/i);
  });
});

describe("submitPullRequest / foldPullRequest", () => {
  it("opens the pull request with that title and body", async () => {
    const { context, calls } = githubOf([]);
    const result = await submitPullRequest(
      {
        key: KEY,
        project: "app",
        ref: "issue/x",
        target: "main",
        title: "Add slugify.",
        intention: "Why.",
      },
      context,
    );
    assert.deepEqual(result, {
      outcome: "submitted",
      reference: "https://github.com/tilap/mason/pull/12",
    });
    const opened = calls.find((call) => call.method === "POST");
    assert.equal(opened?.body.title, "Add slugify (#7)");
    assert.match(
      String(opened?.body.body),
      /^Why\.\n\nCloses #7\n\n<!-- commit-message\nAdd slugify \(#7\)\n\nWhy\.\n-->$/,
    );
    assert.equal(opened?.body.head, "issue/x");
    assert.equal(opened?.body.base, "main");
  });

  it("reuses an open pull request for the same branch", async () => {
    const { context, calls } = githubOf([{ number: 12, head: { sha: "abc" } }]);
    const result = await submitPullRequest(
      { key: KEY, project: "app", ref: "issue/x", target: "main" },
      context,
    );
    assert.deepEqual(result, {
      outcome: "submitted",
      reference: "https://github.com/tilap/mason/pull/12",
    });
    assert.equal(
      calls.some((call) => call.method === "POST"),
      false,
    );
  });

  it("folds by squash, names the commit, and deletes the branch it came from", async () => {
    const { context, calls } = githubOf([]);
    const result = await foldPullRequest("https://github.com/tilap/mason/pull/12", context);
    assert.deepEqual(result, {
      outcome: "folded",
      reference: "9aeff612f47153162c4b73b90cae5ec767230b3d",
    });
    const merged = calls.find((call) => call.method === "PUT");
    assert.equal(merged?.body.merge_method, "squash");
    assert.equal(merged?.body.commit_title, "Add slugify (#7)");
    assert.equal(merged?.body.commit_message, "What it does.\n\nCloses #7");
    const deleted = calls.find((call) => call.method === "DELETE");
    assert.equal(deleted?.path, "/repos/tilap/mason/git/refs/heads/issue/7");
    assert.ok(
      calls.indexOf(deleted ?? calls[0]) > calls.indexOf(merged ?? calls[0]),
      "after the merge",
    );
  });

  it("keeps the branch when asked, and still folds when the delete fails", async () => {
    const kept = githubOf([]);
    await foldPullRequest("https://github.com/tilap/mason/pull/12", {
      ...kept.context,
      keepBranch: true,
    });
    assert.equal(
      kept.calls.some((call) => call.method === "DELETE"),
      false,
    );

    const { context, calls } = githubOf([]);
    const original = context.github;
    // A delete that answers 422 (protected, already gone): the fold stands.
    const failing = {
      ...original,
      request: (async (route: string, params: unknown) => {
        if (String(route).startsWith("DELETE")) {
          throw Object.assign(new Error("Reference does not exist"), { status: 422 });
        }
        return await original.request(route as never, params as never);
      }) as unknown as typeof original.request,
    } as typeof original;
    const result = await foldPullRequest("https://github.com/tilap/mason/pull/12", {
      ...context,
      github: failing,
    });
    assert.equal(result.outcome, "folded");
    assert.equal(
      calls.some((call) => call.method === "PUT"),
      true,
    );
  });
});
