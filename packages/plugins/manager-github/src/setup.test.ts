import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EVENT_NAMES, type ManagerContext } from "@bluewombat/manager-kit";
import { setupManager } from "./index.js";
import { wantedLabels } from "./setup.js";

type Call = { method: string; path: string; body: Record<string, unknown> };

function githubOf(
  repository: Record<string, unknown>,
  labels: string[],
  over: { repoStatus?: number; branches?: string[] } = {},
): { fetch: typeof fetch; calls: Call[] } {
  const branches = over.branches ?? ["main"];
  const calls: Call[] = [];
  const handler = (async (input: unknown, init: { method?: string; body?: unknown } = {}) => {
    const method = String(init.method ?? "GET").toUpperCase();
    const path = new URL(String(input)).pathname;
    const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
    calls.push({ method, path, body });

    if (method === "GET" && path === "/repos/tilap/mason") {
      const status = over.repoStatus ?? 200;
      return json(status, status === 200 ? repository : { message: "Not Found" });
    }
    if (method === "GET" && path.startsWith("/repos/tilap/mason/branches/")) {
      const name = decodeURIComponent(path.slice("/repos/tilap/mason/branches/".length));
      return branches.includes(name)
        ? json(200, { name })
        : json(404, { message: "Branch not found" });
    }
    if (method === "GET" && path === "/repos/tilap/mason/labels") {
      return json(
        200,
        labels.map((name) => ({ name })),
      );
    }
    if (method === "POST" && path === "/repos/tilap/mason/labels") {
      labels.push(String(body.name));
      return json(201, { name: body.name });
    }
    return json(404, { message: `No fixture for ${method} ${path}` });
  }) as unknown as typeof globalThis.fetch;
  return { fetch: handler, calls };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function repositoryOf(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { has_issues: true, permissions: { push: true, pull: true, admin: false }, ...over };
}

function contextOf(options: Record<string, unknown>): ManagerContext {
  return {
    options: { repo: "tilap/mason", token: "t", ...options },
    durationMs: 30_000,
    interruptFlag: { interrupted: false },
    configDir: "/tmp",
    env: {},
  };
}

function stateOf(result: Awaited<ReturnType<typeof setupManager>>, id: string) {
  return result.steps.find((step) => step.id === id)?.state;
}

function detailOf(result: Awaited<ReturnType<typeof setupManager>>, id: string): string {
  return result.steps.find((step) => step.id === id)?.detail ?? "";
}

describe("wantedLabels", () => {
  it("covers the admission labels, ready, the project, and one per Event", () => {
    const names = wantedLabels({
      readyLabel: "ready",
      labels: ["mason"],
      defaultProject: "app",
      stateLabelPrefix: "mason:",
    }).map((label) => label.name);
    assert.deepEqual(names.slice(0, 3), ["mason", "ready", "project:app"]);
    assert.ok(names.includes("mason:done"));
    assert.equal(names.length, 3 + EVENT_NAMES.length);
  });

  it("names a label once even when two settings ask for it", () => {
    const names = wantedLabels({
      readyLabel: "ready",
      labels: ["ready"],
      defaultProject: undefined,
      stateLabelPrefix: undefined,
    }).map((label) => label.name);
    assert.deepEqual(names, ["ready"]);
  });
});

describe("setupManager", () => {
  it("plans without writing anything", async () => {
    const { fetch, calls } = githubOf(repositoryOf(), ["mason"]);
    const result = await setupManager(contextOf({ labels: ["mason"], fetch }), { apply: false });
    assert.equal(result.ok, true);
    assert.equal(stateOf(result, "label:mason"), "satisfied");
    assert.equal(stateOf(result, "label:ready"), "missing");
    assert.equal(
      calls.some((call) => call.method === "POST"),
      false,
    );
  });

  it("creates only the missing labels when applying", async () => {
    const { fetch, calls } = githubOf(repositoryOf(), ["mason"]);
    const result = await setupManager(contextOf({ labels: ["mason"], fetch }), { apply: true });
    assert.equal(result.ok, true);
    assert.equal(stateOf(result, "label:ready"), "applied");
    const created = calls.filter((call) => call.method === "POST").map((call) => call.body.name);
    assert.deepEqual(created, ["ready"]);
  });

  it("is idempotent: a second apply writes nothing", async () => {
    const { fetch, calls } = githubOf(repositoryOf(), []);
    await setupManager(contextOf({ labels: ["mason"], fetch }), { apply: true });
    const before = calls.filter((call) => call.method === "POST").length;
    const again = await setupManager(contextOf({ labels: ["mason"], fetch }), { apply: true });
    assert.equal(calls.filter((call) => call.method === "POST").length, before);
    assert.ok(again.steps.every((step) => step.state === "satisfied"));
  });

  it("blocks on a repository the token cannot see", async () => {
    const { fetch } = githubOf(repositoryOf(), [], { repoStatus: 404 });
    const result = await setupManager(contextOf({ fetch }), { apply: true });
    assert.equal(result.ok, false);
    assert.equal(stateOf(result, "repository"), "blocked");
  });

  it("blocks on disabled issues and on a token that cannot write", async () => {
    const noIssues = githubOf(repositoryOf({ has_issues: false }), []);
    const first = await setupManager(contextOf({ fetch: noIssues.fetch }), { apply: true });
    assert.equal(first.ok, false);
    assert.equal(stateOf(first, "issues"), "blocked");
    assert.equal(
      noIssues.calls.some((call) => call.method === "POST"),
      false,
    );

    const readOnly = githubOf(repositoryOf({ permissions: { push: false, pull: true } }), []);
    const second = await setupManager(contextOf({ fetch: readOnly.fetch }), { apply: true });
    assert.equal(second.ok, false);
    assert.equal(stateOf(second, "write-access"), "blocked");
  });

  it("checks the branch pull requests are opened onto, and names the default when it is not there", async () => {
    const onMain = githubOf(repositoryOf({ default_branch: "main" }), []);
    const first = await setupManager(contextOf({ fetch: onMain.fetch }), { apply: false });
    assert.equal(stateOf(first, "branch"), "satisfied");
    assert.match(detailOf(first, "branch"), /default branch/);

    // The repository lives on `master`; nothing in the config says so.
    const onMaster = githubOf(repositoryOf({ default_branch: "master" }), [], {
      branches: ["master"],
    });
    const second = await setupManager(contextOf({ fetch: onMaster.fetch }), { apply: true });
    assert.equal(second.ok, false);
    assert.equal(stateOf(second, "branch"), "blocked");
    assert.match(detailOf(second, "branch"), /No branch "main"/);
    assert.match(detailOf(second, "branch"), /default branch is "master"/);
    assert.match(detailOf(second, "branch"), /managerOptions\.branch/);
    assert.equal(
      onMaster.calls.some((call) => call.method === "POST"),
      false,
    );

    // Named in the config, and it exists: fine even when it is not the default.
    const named = githubOf(repositoryOf({ default_branch: "main" }), [], {
      branches: ["main", "develop"],
    });
    const third = await setupManager(contextOf({ branch: "develop", fetch: named.fetch }), {
      apply: false,
    });
    assert.equal(stateOf(third, "branch"), "satisfied");
    assert.match(detailOf(third, "branch"), /not the default branch \(main\)/);

    // Named in the config, and it does not exist.
    const wrong = githubOf(repositoryOf({ default_branch: "main" }), []);
    const fourth = await setupManager(contextOf({ branch: "release", fetch: wrong.fetch }), {
      apply: false,
    });
    assert.equal(stateOf(fourth, "branch"), "blocked");
    assert.match(
      detailOf(fourth, "branch"),
      /No branch "release" on tilap\/mason \(managerOptions\.branch\)/,
    );
  });

  it("blocks when no token is set", async () => {
    const result = await setupManager(
      {
        options: { repo: "tilap/mason" },
        durationMs: 1000,
        interruptFlag: { interrupted: false },
        configDir: "/tmp",
        env: {},
      },
      { apply: false },
    );
    assert.equal(result.ok, false);
    assert.equal(stateOf(result, "token"), "blocked");
  });
});
