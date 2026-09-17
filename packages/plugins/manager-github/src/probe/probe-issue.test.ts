import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type ClientOptions, createClient, type GithubClient } from "../github/client.js";
import { createGithubManager } from "../manager.js";
import { probeIssue } from "./probe-issue.js";

type Answer = { status: number; body?: unknown };

function channelOf(answer: (url: string) => Answer): { github: GithubClient; urls: string[] } {
  const urls: string[] = [];
  const fetch = (async (input: unknown): Promise<Response> => {
    const url = String(input);
    urls.push(url);
    const given = answer(url);
    return new Response(given.body === undefined ? null : JSON.stringify(given.body), {
      status: given.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;

  const github = createClient({
    token: "test-token",
    apiBase: "https://api.github.com",
    requestRetries: 0,
    deadlineMs: Date.now() + 10_000,
    fetch,
    throttle: false,
  } satisfies ClientOptions);
  return { github, urls };
}

function probeOf(github: GithubClient, over: { interrupted?: boolean } = {}) {
  const now = (): number => Date.now();
  return probeIssue({
    github,
    repo: { owner: "tilap", name: "mason" },
    number: 42,
    deadlineMs: now() + 5_000,
    now,
    shouldInterrupt: () => over.interrupted === true,
  });
}

describe("probeIssue", () => {
  it("an open issue is present", async () => {
    const { github, urls } = channelOf(() => ({ status: 200, body: { state: "open" } }));
    assert.equal(await probeOf(github), "present");
    assert.match(urls[0] ?? "", /\/repos\/tilap\/mason\/issues\/42/);
  });

  it("a closed issue is gone", async () => {
    const { github } = channelOf(() => ({ status: 200, body: { state: "closed" } }));
    assert.equal(await probeOf(github), "gone");
  });

  it("a 404 is gone", async () => {
    const { github } = channelOf(() => ({ status: 404, body: { message: "Not Found" } }));
    assert.equal(await probeOf(github), "gone");
  });

  it("a 410 is gone", async () => {
    const { github } = channelOf(() => ({ status: 410, body: { message: "Gone" } }));
    assert.equal(await probeOf(github), "gone");
  });

  it("a 403 is unavailable", async () => {
    const { github } = channelOf(() => ({ status: 403, body: { message: "Forbidden" } }));
    assert.equal(await probeOf(github), "unavailable");
  });

  it("a 500 is unavailable", async () => {
    const { github } = channelOf(() => ({ status: 500, body: { message: "oops" } }));
    assert.equal(await probeOf(github), "unavailable");
  });

  it("a body without a state is unavailable, not gone", async () => {
    const { github } = channelOf(() => ({ status: 200, body: { number: 42 } }));
    assert.equal(await probeOf(github), "unavailable");
  });
});

describe("createGithubManager.probe", () => {
  it("recovers the issue from the minted key", async () => {
    const fetch = (async () =>
      new Response(JSON.stringify({ state: "open" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof globalThis.fetch;
    const manager = createGithubManager({
      repo: { owner: "tilap", name: "mason" },
      token: "test-token",
      durationMs: 5_000,
      interruptFlag: { interrupted: false },
      githubFetch: fetch,
    });
    assert.equal(await manager.probe?.("github:tilap/mason#42"), "present");
  });

  it("a key with no issue number is unavailable", async () => {
    const manager = createGithubManager({
      repo: { owner: "tilap", name: "mason" },
      token: "test-token",
      durationMs: 5_000,
      interruptFlag: { interrupted: false },
      githubFetch: (async () => {
        throw new Error("must not fetch");
      }) as unknown as typeof globalThis.fetch,
    });
    assert.equal(await manager.probe?.("github:unconvertible"), "unavailable");
  });
});
