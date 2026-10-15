import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EVENT_NAMES, type ManagerContext } from "@bluewombat/manager-kit";
import { setupManager } from "./index.js";
import { wantedLabels } from "./setup.js";
import { resolveStateLabels } from "./state-labels.js";

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

function contextOf(
  options: Record<string, unknown>,
  sides?: ManagerContext["sides"],
): ManagerContext {
  return {
    options: { repo: "tilap/mason", token: "t", ...options },
    durationMs: 30_000,
    interruptFlag: { interrupted: false },
    configDir: "/tmp",
    env: {},
    ...(sides !== undefined ? { sides } : {}),
  };
}

function stateOf(result: Awaited<ReturnType<typeof setupManager>>, id: string) {
  return result.steps.find((step) => step.id === id)?.state;
}

function detailOf(result: Awaited<ReturnType<typeof setupManager>>, id: string): string {
  return result.steps.find((step) => step.id === id)?.detail ?? "";
}

function labelsOf(over: Record<string, string> = {}) {
  const resolved = resolveStateLabels({
    ...Object.fromEntries(EVENT_NAMES.map((event) => [event, `mason:${event}`])),
    ...over,
  });
  if (!resolved.ok || resolved.labels === undefined) {
    throw new Error("state labels expected");
  }
  return resolved.labels;
}

const MASON = labelsOf();

const LABELS = {
  resumeLabel: "to-resume",
  featureReadyLabel: "feature-ready",
  ticketReadyLabel: "task-ready",
  mergeWhenReadyLabel: "merge-when-ready",
};

describe("wantedLabels", () => {
  it("covers the three signals, the resume label, the project, and one per Event", () => {
    const names = wantedLabels({
      ...LABELS,
      defaultProject: "app",
      stateLabels: MASON,
    }).map((label) => label.name);
    assert.deepEqual(names.slice(0, 5), [
      "feature-ready",
      "task-ready",
      "merge-when-ready",
      "to-resume",
      "project:app",
    ]);
    assert.ok(names.includes("mason:done"));
    assert.equal(names.length, 5 + EVENT_NAMES.length);
  });

  it("names a label once even when two settings ask for it", () => {
    const names = wantedLabels({
      ...LABELS,
      ticketReadyLabel: "to-resume",
      defaultProject: undefined,
      stateLabels: undefined,
    }).map((label) => label.name);
    assert.deepEqual(names, ["feature-ready", "to-resume", "merge-when-ready"]);
  });
});

describe("wantedLabels with one name for both roles", () => {
  it("creates it once and says both roles in its description", () => {
    const labels = wantedLabels({
      ...LABELS,
      featureReadyLabel: "ready-for-agent",
      ticketReadyLabel: "ready-for-agent",
      defaultProject: undefined,
      stateLabels: undefined,
    });
    assert.deepEqual(
      labels.map((label) => label.name),
      ["ready-for-agent", "merge-when-ready", "to-resume"],
    );
    assert.match(labels[0]?.description ?? "", /Feature.*Ticket/);
  });

  it("matches the shared name whatever its case", () => {
    const names = wantedLabels({
      ...LABELS,
      featureReadyLabel: "Ready-For-Agent",
      ticketReadyLabel: "ready-for-agent",
      defaultProject: undefined,
      stateLabels: undefined,
    }).map((label) => label.name);
    assert.deepEqual(names, ["Ready-For-Agent", "merge-when-ready", "to-resume"]);
  });
});

describe("wantedLabels for one side", () => {
  const rest = { ...LABELS, defaultProject: undefined, stateLabels: undefined };

  it("wants only the Ticket label and the resume label for the ticket tracker", () => {
    const names = wantedLabels({ ...rest, sides: ["ticketTracker"] }).map((label) => label.name);
    assert.deepEqual(names, ["task-ready", "to-resume"]);
  });

  it("wants only the Feature labels and the resume label for the feature tracker", () => {
    const names = wantedLabels({ ...rest, sides: ["featureTracker"] }).map((label) => label.name);
    assert.deepEqual(names, ["feature-ready", "merge-when-ready", "to-resume"]);
  });
});

function namedLabels(over: Record<string, string> = {}): Record<string, string> {
  return { ...Object.fromEntries(EVENT_NAMES.map((event) => [event, `mason:${event}`])), ...over };
}

describe("wantedLabels for state labels", () => {
  it("wants the label the configuration chose for each Event", () => {
    const names = wantedLabels({
      ...LABELS,
      defaultProject: undefined,
      stateLabels: labelsOf({ done: "termine" }),
    }).map((label) => label.name);
    assert.ok(names.includes("termine"));
    assert.ok(names.includes("mason:accepted"));
    assert.equal(names.includes("mason:done"), false);
  });
});

describe("setupManager", () => {
  it("plans without writing anything", async () => {
    const { fetch, calls } = githubOf(repositoryOf(), ["feature-ready"]);
    const result = await setupManager(contextOf({ fetch }), { apply: false });
    assert.equal(result.ok, true);
    assert.equal(stateOf(result, "label:feature-ready"), "satisfied");
    assert.equal(stateOf(result, "label:task-ready"), "missing");
    assert.equal(stateOf(result, "label:merge-when-ready"), "missing");
    assert.equal(stateOf(result, "label:to-resume"), "missing");
    assert.equal(
      calls.some((call) => call.method === "POST"),
      false,
    );
  });

  it("creates only the missing labels when applying", async () => {
    const { fetch, calls } = githubOf(repositoryOf(), ["feature-ready", "task-ready"]);
    const result = await setupManager(contextOf({ fetch }), { apply: true });
    assert.equal(result.ok, true);
    assert.equal(stateOf(result, "label:to-resume"), "applied");
    const created = calls.filter((call) => call.method === "POST").map((call) => call.body.name);
    assert.deepEqual(created, ["merge-when-ready", "to-resume"]);
  });

  it("names the labels the configuration chose, not the defaults", async () => {
    const { fetch, calls } = githubOf(repositoryOf(), []);
    await setupManager(
      contextOf({
        featureReadyLabel: "spec-done",
        ticketReadyLabel: "ticket-done",
        mergeWhenReadyLabel: "auto-merge",
        resumeLabel: "go",
        fetch,
      }),
      { apply: true },
    );
    const created = calls.filter((call) => call.method === "POST").map((call) => call.body.name);
    assert.deepEqual(created, ["spec-done", "ticket-done", "auto-merge", "go"]);
  });

  it("creates one label on GitHub when both roles share a name", async () => {
    const { fetch, calls } = githubOf(repositoryOf(), []);
    const result = await setupManager(
      contextOf({
        featureReadyLabel: "ready-for-agent",
        ticketReadyLabel: "ready-for-agent",
        fetch,
      }),
      { apply: true },
    );
    assert.equal(result.ok, true);
    const created = calls.filter((call) => call.method === "POST").map((call) => call.body.name);
    assert.deepEqual(created, ["ready-for-agent", "merge-when-ready", "to-resume"]);
  });

  it("defaults to feature-ready on a Feature and task-ready on a Ticket", async () => {
    const { fetch, calls } = githubOf(repositoryOf(), []);
    await setupManager(contextOf({ fetch }), { apply: true });
    const created = calls.filter((call) => call.method === "POST").map((call) => call.body.name);
    assert.deepEqual(created, ["feature-ready", "task-ready", "merge-when-ready", "to-resume"]);
  });

  it("creates only the Ticket label for the ticket tracker, whatever the other side calls its own", async () => {
    const { fetch, calls } = githubOf(repositoryOf(), []);
    const result = await setupManager(
      contextOf({ ticketReadyLabel: "ticket-done", fetch }, ["ticketTracker"]),
      { apply: true },
    );
    assert.equal(result.ok, true);
    const created = calls.filter((call) => call.method === "POST").map((call) => call.body.name);
    assert.deepEqual(created, ["ticket-done", "to-resume"]);
  });

  it("blocks when an option sits under the wrong side", async () => {
    const { fetch, calls } = githubOf(repositoryOf(), []);
    const result = await setupManager(
      contextOf({ featureReadyLabel: "spec-done", fetch }, ["ticketTracker"]),
      { apply: true },
    );
    assert.equal(result.ok, false);
    assert.match(detailOf(result, "options"), /"featureReadyLabel" belongs under featureTracker/);
    assert.equal(
      calls.some((call) => call.method === "POST"),
      false,
    );
  });

  it("creates the state labels named by stateLabels, once each", async () => {
    const { fetch, calls } = githubOf(repositoryOf(), []);
    const result = await setupManager(
      contextOf({ stateLabels: namedLabels({ done: "termine" }), fetch }),
      { apply: true },
    );
    assert.equal(result.ok, true);
    const created = calls.filter((call) => call.method === "POST").map((call) => call.body.name);
    assert.ok(created.includes("termine"));
    assert.ok(created.includes("mason:cancelled"));
    assert.equal(created.includes("mason:done"), false);
    assert.equal(new Set(created).size, created.length);
  });

  it("blocks on a stateLabels it cannot read", async () => {
    const { fetch } = githubOf(repositoryOf(), []);
    const result = await setupManager(contextOf({ stateLabels: { planned: "x" }, fetch }), {
      apply: true,
    });
    assert.equal(result.ok, false);
    assert.match(detailOf(result, "options"), /"planned".*not an event/);
  });

  it("is idempotent: a second apply writes nothing", async () => {
    const { fetch, calls } = githubOf(repositoryOf(), []);
    await setupManager(contextOf({ fetch }), { apply: true });
    const before = calls.filter((call) => call.method === "POST").length;
    const again = await setupManager(contextOf({ fetch }), { apply: true });
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
