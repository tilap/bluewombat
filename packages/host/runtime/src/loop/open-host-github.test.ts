import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { GateSpec } from "@bluewombat/implementer";
import { openHost } from "./open-host.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures");
const node = process.execPath;
const SEED = "already good\n";
const MARKER = "work done\n";
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

const FEATURE = "github:tilap/mason#10";

type Issues = {
  feature: Record<string, unknown> | undefined;
  ticket: Record<string, unknown>;
};

function featureIssue(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 10,
    title: "A feature",
    body: "What it is for.\n",
    state: "open",
    labels: [{ name: "project:proj" }, { name: "feature-ready" }],
    html_url: "https://github.com/tilap/mason/issues/10",
    updated_at: "2026-09-06T10:00:00Z",
    ...over,
  };
}

function ticketIssue(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 42,
    title: "Deliver the marker",
    body: issueBody(),
    state: "open",
    labels: [{ name: "task-ready" }],
    html_url: "https://github.com/tilap/mason/issues/42",
    updated_at: "2026-09-06T10:00:00Z",
    ...over,
  };
}

function issuesOf(over: Partial<Issues> = {}): Issues {
  return { feature: featureIssue(), ticket: ticketIssue(), ...over };
}

/** The repository as GitHub would answer: a Feature, its sub-issue, and nothing blocking either. */
function githubFetchOf(current: () => Issues): {
  fetch: typeof fetch;
  comments: Map<number, string[]>;
} {
  const comments = new Map<number, string[]>();
  const fetch = (async (input: unknown, init: { method?: string; body?: unknown } = {}) => {
    const method = String(init.method ?? "GET").toUpperCase();
    const path = new URL(String(input)).pathname;
    const { feature, ticket } = current();

    if (method === "GET" && path === "/repos/tilap/mason/issues") {
      return json(200, feature === undefined ? [] : [feature]);
    }
    if (method === "GET" && path === "/repos/tilap/mason/issues/10") {
      return feature === undefined ? json(404, { message: "Not Found" }) : json(200, feature);
    }
    if (method === "GET" && path === "/repos/tilap/mason/issues/42") {
      return json(200, ticket);
    }
    if (method === "GET" && path === "/repos/tilap/mason/issues/10/sub_issues") {
      return json(200, feature === undefined ? [] : [ticket]);
    }
    if (method === "GET" && /\/issues\/(10|42)\/dependencies\/blocked_by$/.test(path)) {
      return json(200, []);
    }
    if (method === "GET" && /\/issues\/(10|42)\/comments$/.test(path)) {
      return json(200, []);
    }
    const posted = /\/issues\/(10|42)\/comments$/.exec(path);
    if (method === "POST" && posted?.[1] !== undefined) {
      const parsed = typeof init.body === "string" ? JSON.parse(init.body) : {};
      if (typeof parsed.body === "string") {
        const number = Number(posted[1]);
        comments.set(number, [...(comments.get(number) ?? []), parsed.body]);
      }
      return json(201, { html_url: "https://github.com/tilap/mason/issues/10#issuecomment-1" });
    }
    if (/\/issues\/(10|42)\/labels/.test(path)) {
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
    featureTracker: {
      package: "@bluewombat/manager-github",
      options: {
        repo: "tilap/mason",
        token: "test-token",
        fetch,
        defaultProject: "proj",
      },
    },
    ticketTracker: {
      package: "@bluewombat/manager-github",
      options: {
        repo: "tilap/mason",
        token: "test-token",
        fetch,
        defaultProject: "proj",
      },
    },
    workLineStable: paths.workLineStable,
    workLineIsolation: "@bluewombat/isolation-copy",
    workspaceRoot: paths.workspaceRoot,
    ledgerRoot: paths.ledgerRoot,
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
    ticket: { gates: [] },
    timeoutMs: 30_000,
  });
}

describe("host GitHub", () => {
  it("1. a Feature with a task-ready sub-issue: marker on WorkLineStable, both issues told", async () => {
    const paths = sandbox();
    const issues = issuesOf();
    const { fetch, comments } = githubFetchOf(() => issues);
    const host = await hostFor(paths, passingGates(), fetch);
    const tick = await host.runOnce();
    assert.equal(tick.lastRun?.outcome, "done");
    assert.deepEqual(tick.reported, ["accepted", "accepted", "done", "progress", "done"]);
    assert.equal(readFileSync(join(paths.workLineStable, "delivered.txt"), "utf8"), MARKER);
    assert.equal(comments.get(10)?.length, 3);
    assert.equal(comments.get(42)?.length, 2);
    const feature = await host.ledger.getFeature(FEATURE);
    assert.equal(feature.ok && feature.aggregate.state, "done");
    const got = await host.ledger.get(KEY);
    assert.equal(got.ok && got.aggregate.state, "done");
    assert.equal(got.ok && got.aggregate.intention.feature, FEATURE);
  });

  it("2. a Feature with nothing saying what it is: invalid, seed-only", async () => {
    const paths = sandbox();
    const issues = issuesOf({ feature: featureIssue({ body: null, title: null }) });
    const { fetch, comments } = githubFetchOf(() => issues);
    const host = await hostFor(paths, passingGates(), fetch);
    const tick = await host.runOnce();
    assert.equal(tick.lastRun, undefined);
    assert.deepEqual(tick.reported, ["invalid"]);
    assert.equal(comments.get(10)?.length, 1);
    assert.equal((await host.ledger.getFeature(FEATURE)).ok, false);
  });

  it("3. a Ticket escalates, its issue gets the resume label, it resumes and the Feature is done", async () => {
    const paths = sandbox();
    let issues = issuesOf();
    const { fetch } = githubFetchOf(() => issues);
    const blocked = await hostFor(paths, blockingGates(), fetch);
    const first = await blocked.runOnce();
    assert.equal(first.lastRun?.outcome, "escalated");
    assert.ok(first.reported.includes("escalated"));
    await blocked.close();

    issues = issuesOf({
      ticket: ticketIssue({
        labels: [{ name: "task-ready" }, { name: "to-resume" }],
        updated_at: "2026-09-06T11:00:00Z",
      }),
    });
    const resumed = await hostFor(paths, passingGates(), fetch);
    const second = await resumed.runOnce();
    assert.equal(second.lastRun?.outcome, "done");
    assert.ok(second.reported.includes("resumed"));
    assert.ok(second.reported.includes("done"));
    assert.equal(readFileSync(join(paths.workLineStable, "delivered.txt"), "utf8"), MARKER);
  });

  it("4. the Feature's issue closed while a Ticket is escalated: both cancelled", async () => {
    const paths = sandbox();
    let issues = issuesOf();
    const { fetch } = githubFetchOf(() => issues);
    const blocked = await hostFor(paths, blockingGates(), fetch);
    await blocked.runOnce();
    issues = issuesOf({
      feature: featureIssue({ state: "closed", updated_at: "2026-09-06T11:00:00Z" }),
    });
    const tick = await blocked.runOnce();
    assert.deepEqual(tick.reported, ["cancelled", "cancelled"]);
    const feature = await blocked.ledger.getFeature(FEATURE);
    assert.equal(feature.ok && feature.aggregate.state, "cancelled");
    const got = await blocked.ledger.get(KEY);
    assert.equal(got.ok && got.aggregate.state, "cancelled");
  });

  it("5. the Feature's issue deleted while a Ticket is escalated: cancelled, even though the listing never mentions it", async () => {
    const paths = sandbox();
    let issues = issuesOf();
    const { fetch } = githubFetchOf(() => issues);
    const blocked = await hostFor(paths, blockingGates(), fetch);
    const first = await blocked.runOnce();
    assert.equal(first.lastRun?.outcome, "escalated");

    issues = issuesOf({ feature: undefined });
    await blocked.runOnce();
    const feature = await blocked.ledger.getFeature(FEATURE);
    assert.equal(feature.ok && feature.aggregate.state, "cancelled");
    const got = await blocked.ledger.get(KEY);
    assert.equal(got.ok && got.aggregate.state, "cancelled");
    assert.match(
      readFileSync(join(paths.ledgerRoot, "events.jsonl"), "utf8"),
      /"event":"probed"[^\n]*"gone"/,
    );
  });
});
