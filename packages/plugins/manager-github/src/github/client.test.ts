import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createClient } from "./client.js";
import { createEtagCache } from "./etag-cache.js";

/**
 * A network whose first `silent` answers never come — until the attempt is
 * aborted — and whose next ones answer at once.
 */
function network(silent: number): { fetch: typeof globalThis.fetch; calls: () => number } {
  let calls = 0;
  const fetch = ((_input: unknown, init: { signal?: AbortSignal } = {}) => {
    calls += 1;
    if (calls > silent) {
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return new Promise((_resolve, reject) => {
      if (init.signal?.aborted === true) {
        reject(init.signal.reason);
        return;
      }
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls: () => calls };
}

function client(fetch: typeof globalThis.fetch, requestRetries: number) {
  return createClient({
    token: "t",
    apiBase: "https://api.github.com",
    requestRetries,
    deadlineMs: Date.now() + 60_000,
    fetch,
    throttle: false,
    requestTimeoutMs: 100,
  });
}

describe("createClient", () => {
  it("tries again when GitHub goes silent, instead of waiting out the invocation", async () => {
    // A report once waited five minutes on one request; the work waited with it.
    const { fetch, calls } = network(1);
    const started = Date.now();
    const answer = await client(fetch, 1).request("GET /rate_limit");
    assert.equal(answer.status, 200);
    assert.equal(calls(), 2);
    assert.ok(Date.now() - started < 10_000, `took ${Date.now() - started} ms`);
  });

  it("says GitHub did not answer once every attempt went silent", async () => {
    const { fetch, calls } = network(Number.POSITIVE_INFINITY);
    await assert.rejects(
      client(fetch, 1).request("GET /rate_limit"),
      /did not answer within 100 ms/,
    );
    assert.equal(calls(), 2);
  });

  it("does not retry the caller's own abort", async () => {
    const { fetch, calls } = network(Number.POSITIVE_INFINITY);
    const stop = new AbortController();
    stop.abort();
    await assert.rejects(
      client(fetch, 2).request("GET /rate_limit", { request: { signal: stop.signal } }),
    );
    assert.equal(calls(), 1);
  });
});

/** One request as GitHub saw it. */
type Seen = { method: string; url: string; ifNoneMatch: string | null };

/**
 * GitHub, as far as conditional reads go: each GET answers 200 with the etag
 * of its current body, or 304 when the request already names that etag.
 */
function github(bodyOf: (url: string) => unknown): {
  fetch: typeof globalThis.fetch;
  seen: Seen[];
} {
  const seen: Seen[] = [];
  const fetch = (async (input: unknown, init: { method?: string; headers?: unknown } = {}) => {
    const headers = new Headers(init.headers as ConstructorParameters<typeof Headers>[0]);
    const method = String(init.method ?? "GET").toUpperCase();
    const url = String(input);
    seen.push({ method, url, ifNoneMatch: headers.get("if-none-match") });
    const body = JSON.stringify(bodyOf(url));
    const etag = `"${Buffer.from(body).toString("base64url")}"`;
    if (method === "GET" && headers.get("if-none-match") === etag) {
      return new Response(null, { status: 304, headers: { etag } });
    }
    return new Response(body, {
      status: 200,
      headers: { "content-type": "application/json", ...(method === "GET" ? { etag } : {}) },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, seen };
}

function cached(fetch: typeof globalThis.fetch, etags = createEtagCache()) {
  return createClient({
    token: "t",
    apiBase: "https://api.github.com",
    requestRetries: 0,
    deadlineMs: Date.now() + 60_000,
    fetch,
    throttle: false,
    etags,
  });
}

describe("conditional reads", () => {
  it("asks again with the etag, and hands back the kept answer on a 304", async () => {
    // A 304 sent with a token does not count against its hourly budget.
    const { fetch, seen } = github(() => [{ number: 7 }]);
    const client = cached(fetch);
    const first = await client.request("GET /repos/{owner}/{repo}/issues", {
      owner: "o",
      repo: "r",
    });
    const again = await client.request("GET /repos/{owner}/{repo}/issues", {
      owner: "o",
      repo: "r",
    });
    assert.equal(seen.length, 2);
    // GitHub answered 304: the second request named the etag it had.
    assert.equal(seen[1]?.ifNoneMatch, first.headers.etag);
    // Whole and unchanged: a page not consumed yet is delivered again, not lost.
    assert.equal(again.status, 200);
    assert.deepEqual(again.data, [{ number: 7 }]);
  });

  it("keeps the new answer when GitHub has one", async () => {
    let body: unknown = [{ number: 7 }];
    const { fetch, seen } = github(() => body);
    const client = cached(fetch);
    await client.request("GET /repos/{owner}/{repo}/issues", { owner: "o", repo: "r" });
    body = [{ number: 7 }, { number: 8 }];
    const changed = await client.request("GET /repos/{owner}/{repo}/issues", {
      owner: "o",
      repo: "r",
    });
    assert.deepEqual(changed.data, [{ number: 7 }, { number: 8 }]);
    const after = await client.request("GET /repos/{owner}/{repo}/issues", {
      owner: "o",
      repo: "r",
    });
    assert.deepEqual(after.data, [{ number: 7 }, { number: 8 }]);
    assert.equal(seen[2]?.ifNoneMatch, changed.headers.etag);
  });

  it("keeps one answer per URL, query included", async () => {
    const { fetch, seen } = github((url) => [{ url }]);
    const client = cached(fetch);
    const route = "GET /repos/{owner}/{repo}/issues";
    await client.request(route, { owner: "o", repo: "r", page: 1 });
    const second = await client.request(route, { owner: "o", repo: "r", page: 2 });
    assert.equal(seen[1]?.ifNoneMatch, null);
    assert.match(JSON.stringify(second.data), /page=2/);
  });

  it("never makes a write conditional", async () => {
    const { fetch, seen } = github(() => ({ id: 1 }));
    const client = cached(fetch);
    const route = "POST /repos/{owner}/{repo}/issues/{issue_number}/comments";
    await client.request(route, { owner: "o", repo: "r", issue_number: 7, body: "x" });
    await client.request(route, { owner: "o", repo: "r", issue_number: 7, body: "x" });
    assert.deepEqual(
      seen.map((call) => call.ifNoneMatch),
      [null, null],
    );
  });

  it("reads in full without a cache", async () => {
    const { fetch, seen } = github(() => []);
    const client = createClient({
      token: "t",
      apiBase: "https://api.github.com",
      requestRetries: 0,
      deadlineMs: Date.now() + 60_000,
      fetch,
      throttle: false,
    });
    await client.request("GET /rate_limit");
    await client.request("GET /rate_limit");
    assert.deepEqual(
      seen.map((call) => call.ifNoneMatch),
      [null, null],
    );
  });
});
