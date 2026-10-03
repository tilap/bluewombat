import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createClient } from "./client.js";

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
