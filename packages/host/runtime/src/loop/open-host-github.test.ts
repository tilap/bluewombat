import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { GateSpec } from "@bluewombat/implementer";
import { openHost } from "./open-host.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures");
const plannerPath = join(fixtures, "planner-one-subtask.mjs");
const node = process.execPath;
const SEED = "already good\n";
const MARKER = "subtask done\n";
const KEY = "github:tilap/mason#42";

type Paths = {
  workLineStable: string;
  workspaceRoot: string;
  ledgerRoot: string;
};

function sandbox(): Paths {
  const root = mkdtempSync(join(tmpdir(), "host-github-"));
  const workLineStable = join(root, "stable");
  mkdirSync(workLineStable);
  writeFileSync(join(workLineStable, "seed.txt"), SEED);
  return {
    workLineStable,
    workspaceRoot: join(root, "workspaces"),
    ledgerRoot: join(root, "ledger"),
  };
}

function passingGates(): GateSpec[] {
  return [{ id: "check", argv: [node, join(fixtures, "gate-pass.mjs")], timeoutMs: 10_000 }];
}

function blockingGates(): GateSpec[] {
  return [
    { id: "check", argv: [node, join(fixtures, "gate-fail-blocking.mjs")], timeoutMs: 10_000 },
  ];
}

function issueBody(): string {
  return "Deliver the marker file: delivered.txt must exist.\n";
}

function issueOf(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 42,
    title: "Deliver the marker",
    body: issueBody(),
    state: "open",
    labels: [{ name: "project:proj" }],
    html_url: "https://github.com/tilap/mason/issues/42",
    updated_at: "2026-09-06T10:00:00Z",
    ...over,
  };
}

function githubFetchOf(currentIssue: () => Record<string, unknown>): {
  fetch: typeof fetch;
  comments: string[];
} {
  const comments: string[] = [];
  const fetch = (async (input: unknown, init: { method?: string; body?: unknown } = {}) => {
    const url = String(input);
    const method = String(init.method ?? "GET").toUpperCase();
    const path = new URL(url).pathname;
    const issue = currentIssue();

    if (method === "GET" && path === "/repos/tilap/mason/issues") {
      return json(200, [issue]);
    }
    if (method === "GET" && path === "/repos/tilap/mason/issues/42") {
      return json(200, issue);
    }
    if (method === "GET" && path === "/repos/tilap/mason/issues/42/comments") {
      return json(200, []);
    }
    if (method === "POST" && path === "/repos/tilap/mason/issues/42/comments") {
      const parsed = typeof init.body === "string" ? JSON.parse(init.body) : {};
      if (typeof parsed.body === "string") {
        comments.push(parsed.body);
      }
      return json(201, { html_url: "https://github.com/tilap/mason/issues/42#issuecomment-1" });
    }
    if (path === "/repos/tilap/mason/issues/42/labels") {
      return json(200, []);
    }
    return json(404, { message: `No fixture for ${method} ${path}` });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, comments };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function hostFor(paths: Paths, gates: GateSpec[], fetch: typeof globalThis.fetch) {
  return await openHost({
    manager: "@bluewombat/manager-github",
    managerOptions: {
      repo: "tilap/mason",
      token: "test-token",
      fetch,
      defaultProject: "proj",
    },
    workLineStable: paths.workLineStable,
    workLineIsolation: "@bluewombat/isolation-copy",
    workspaceRoot: paths.workspaceRoot,
    ledgerRoot: paths.ledgerRoot,
    planner: { cmd: [node, plannerPath], timeoutMs: 30_000, gates: [] },
    builder: {
      producer: {
        cmd: [node, join(fixtures, "builder-write-marker.mjs")],
        timeoutMs: 30_000,
        gates,
      },
      repair: {
        cmd: [node, join(fixtures, "builder-write-marker.mjs")],
        timeoutMs: 30_000,
        gates: [],
      },
    },
    assembly: { gates: [] },
    timeoutMs: 30_000,
  });
}

describe("host GitHub", () => {
  it("1. convertible issue: marker on WorkLineStable, accepted planned done", async () => {
    const paths = sandbox();
    const issue = issueOf();
    const { fetch, comments } = githubFetchOf(() => issue);
    const host = await hostFor(paths, passingGates(), fetch);
    const tick = await host.runOnce();
    assert.equal(tick.lastRun?.outcome, "done");
    assert.deepEqual(tick.reported, ["accepted", "planned", "progress", "done"]);
    assert.equal(readFileSync(join(paths.workLineStable, "delivered.txt"), "utf8"), MARKER);
    assert.equal(comments.length, 4);
    const got = await host.ledger.get(KEY);
    assert.equal(got.ok && got.aggregate.state, "done");
  });

  it("2. nothing saying what to do: invalid, seed-only", async () => {
    const paths = sandbox();
    const { fetch, comments } = githubFetchOf(() => issueOf({ body: null, title: null }));
    const host = await hostFor(paths, passingGates(), fetch);
    const tick = await host.runOnce();
    assert.equal(tick.lastRun, undefined);
    assert.deepEqual(tick.reported, ["invalid"]);
    assert.equal(comments.length, 1);
    const got = await host.ledger.get(KEY);
    assert.equal(got.ok && got.aggregate.state, "invalid");
  });

  it("3. fail-blocking then ready label on the same snapshot: escalated, resumed, done", async () => {
    const paths = sandbox();
    let issue = issueOf();
    const { fetch } = githubFetchOf(() => issue);
    const blocked = await hostFor(paths, blockingGates(), fetch);
    const first = await blocked.runOnce();
    assert.equal(first.lastRun?.outcome, "escalated");
    assert.ok(first.reported.includes("escalated"));

    issue = issueOf({
      labels: [{ name: "project:proj" }, { name: "ready" }],
      updated_at: "2026-09-06T11:00:00Z",
    });
    const resumed = await hostFor(paths, passingGates(), fetch);
    const second = await resumed.runOnce();
    assert.equal(second.lastRun?.outcome, "done");
    assert.ok(second.reported.includes("resumed"));
    assert.ok(second.reported.includes("done"));
    assert.equal(readFileSync(join(paths.workLineStable, "delivered.txt"), "utf8"), MARKER);
  });

  it("4. closed issue while escalated: cancelled", async () => {
    const paths = sandbox();
    let issue = issueOf();
    const { fetch } = githubFetchOf(() => issue);
    const blocked = await hostFor(paths, blockingGates(), fetch);
    await blocked.runOnce();
    issue = issueOf({ state: "closed", updated_at: "2026-09-06T11:00:00Z" });
    const tick = await blocked.runOnce();
    assert.deepEqual(tick.reported, ["cancelled"]);
    const got = await blocked.ledger.get(KEY);
    assert.equal(got.ok && got.aggregate.state, "cancelled");
  });

  it("5. deleted issue while escalated: cancelled, even though the listing never mentions it", async () => {
    const paths = sandbox();
    let issue: Record<string, unknown> | undefined = issueOf();
    const fetch = (async (input: unknown, init: { method?: string; body?: unknown } = {}) => {
      const method = String(init.method ?? "GET").toUpperCase();
      const path = new URL(String(input)).pathname;
      if (issue === undefined) {
        if (method === "GET" && path === "/repos/tilap/mason/issues") {
          return json(200, []);
        }
        if (method === "GET" && path === "/repos/tilap/mason/issues/42") {
          return json(404, { message: "Not Found" });
        }
        return json(404, { message: `No fixture for ${method} ${path}` });
      }
      if (method === "GET" && path === "/repos/tilap/mason/issues") {
        return json(200, [issue]);
      }
      if (method === "GET" && path === "/repos/tilap/mason/issues/42") {
        return json(200, issue);
      }
      if (method === "GET" && path === "/repos/tilap/mason/issues/42/comments") {
        return json(200, []);
      }
      if (method === "POST" && path === "/repos/tilap/mason/issues/42/comments") {
        return json(201, { html_url: "https://github.com/tilap/mason/issues/42#issuecomment-1" });
      }
      if (path === "/repos/tilap/mason/issues/42/labels") {
        return json(200, []);
      }
      return json(404, { message: `No fixture for ${method} ${path}` });
    }) as unknown as typeof globalThis.fetch;

    const blocked = await hostFor(paths, blockingGates(), fetch);
    const first = await blocked.runOnce();
    assert.equal(first.lastRun?.outcome, "escalated");

    issue = undefined;
    await blocked.runOnce();
    const got = await blocked.ledger.get(KEY);
    assert.equal(got.ok && got.aggregate.state, "cancelled");
    assert.match(
      readFileSync(join(paths.ledgerRoot, "events.jsonl"), "utf8"),
      /"event":"probed"[^\n]*"gone"/,
    );
  });
});
