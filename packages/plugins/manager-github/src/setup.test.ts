import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EVENT_NAMES, type ManagerContext } from "@bluewombat/manager-kit";
import { setupManager } from "./index.js";
import { resolveLabelColors } from "./label-colors.js";
import { wantedLabels } from "./setup.js";
import { resolveStateLabels } from "./state-labels.js";

type Call = { method: string; path: string; body: Record<string, unknown> };

function githubOf(
  repository: Record<string, unknown>,
  labels: string[],
  over: { repoStatus?: number; branches?: string[]; colours?: Record<string, string> } = {},
): { fetch: typeof fetch; calls: Call[] } {
  const colours = over.colours ?? {};
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
        labels.map((name) => ({ name, color: colours[name] ?? "ededed" })),
      );
    }
    if (method === "PATCH" && path.startsWith("/repos/tilap/mason/labels/")) {
      colours[decodeURIComponent(path.slice("/repos/tilap/mason/labels/".length))] = String(
        body.color,
      );
      return json(200, { name: body.name });
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
  noTestsLabel: "no-tests",
  e2eLabel: "e2e",
  skipTestE2eLabel: "skip-test-e2e",
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
    assert.deepEqual(names.slice(0, 8), [
      "feature-ready",
      "task-ready",
      "no-tests",
      "e2e",
      "merge-when-ready",
      "skip-test-e2e",
      "to-resume",
      "project:app",
    ]);
    assert.ok(names.includes("mason:done"));
    assert.equal(names.length, 8 + EVENT_NAMES.length);
  });

  it("names a label once even when two settings ask for it", () => {
    const names = wantedLabels({
      ...LABELS,
      ticketReadyLabel: "to-resume",
      defaultProject: undefined,
      stateLabels: undefined,
    }).map((label) => label.name);
    assert.deepEqual(names, [
      "feature-ready",
      "to-resume",
      "no-tests",
      "e2e",
      "merge-when-ready",
      "skip-test-e2e",
    ]);
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
      ["ready-for-agent", "no-tests", "e2e", "merge-when-ready", "skip-test-e2e", "to-resume"],
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
    assert.deepEqual(names, [
      "Ready-For-Agent",
      "no-tests",
      "e2e",
      "merge-when-ready",
      "skip-test-e2e",
      "to-resume",
    ]);
  });
});

describe("wantedLabels for one side", () => {
  const rest = { ...LABELS, defaultProject: undefined, stateLabels: undefined };

  it("wants only the Ticket label and the resume label for the ticket tracker", () => {
    const names = wantedLabels({ ...rest, sides: ["ticketTracker"] }).map((label) => label.name);
    assert.deepEqual(names, ["task-ready", "no-tests", "e2e", "to-resume"]);
  });

  it("wants only the Feature labels and the resume label for the feature tracker", () => {
    const names = wantedLabels({ ...rest, sides: ["featureTracker"] }).map((label) => label.name);
    assert.deepEqual(names, ["feature-ready", "merge-when-ready", "skip-test-e2e", "to-resume"]);
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
    assert.deepEqual(created, [
      "no-tests",
      "e2e",
      "merge-when-ready",
      "skip-test-e2e",
      "to-resume",
    ]);
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
    assert.deepEqual(created, [
      "spec-done",
      "ticket-done",
      "no-tests",
      "e2e",
      "auto-merge",
      "skip-test-e2e",
      "go",
    ]);
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
    assert.deepEqual(created, [
      "ready-for-agent",
      "no-tests",
      "e2e",
      "merge-when-ready",
      "skip-test-e2e",
      "to-resume",
    ]);
  });

  it("defaults to feature-ready on a Feature and task-ready on a Ticket", async () => {
    const { fetch, calls } = githubOf(repositoryOf(), []);
    await setupManager(contextOf({ fetch }), { apply: true });
    const created = calls.filter((call) => call.method === "POST").map((call) => call.body.name);
    assert.deepEqual(created, [
      "feature-ready",
      "task-ready",
      "no-tests",
      "e2e",
      "merge-when-ready",
      "skip-test-e2e",
      "to-resume",
    ]);
  });

  it("creates only the Ticket label for the ticket tracker, whatever the other side calls its own", async () => {
    const { fetch, calls } = githubOf(repositoryOf(), []);
    const result = await setupManager(
      contextOf({ ticketReadyLabel: "ticket-done", fetch }, ["ticketTracker"]),
      { apply: true },
    );
    assert.equal(result.ok, true);
    const created = calls.filter((call) => call.method === "POST").map((call) => call.body.name);
    assert.deepEqual(created, ["ticket-done", "no-tests", "e2e", "to-resume"]);
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

describe("label colours", () => {
  const colours = (named?: Record<string, string>) => {
    const resolved = resolveLabelColors(named);
    if (!resolved.ok) {
      throw new Error(resolved.reason);
    }
    return resolved.colors;
  };
  const colourOfLabel = (wanted: ReturnType<typeof wantedLabels>, name: string) => {
    const found = wanted.find((label) => label.name === name);
    return found === undefined ? undefined : { colour: found.colour, chosen: found.chosen };
  };

  it("keeps the defaults, and chooses nothing, when the config names no colour", () => {
    const wanted = wantedLabels({ ...LABELS, defaultProject: "app", stateLabels: MASON });
    assert.equal(
      wanted.some((label) => label.chosen),
      false,
    );
    assert.equal(colourOfLabel(wanted, "feature-ready")?.colour, "1d76db");
  });

  it("colours each label by its own identifier, whatever it is called", () => {
    const wanted = wantedLabels({
      ...LABELS,
      resumeLabel: "reprendre",
      defaultProject: "app",
      stateLabels: labelsOf({ done: "termine" }),
      labelColors: colours({
        "feature-ready": "#00AA00",
        "ticket-ready": "00bb00",
        "merge-when-ready": "00cc00",
        resume: "ff00ff",
        "state-done": "0000ff",
        "state-escalated": "d93f0b",
      }),
    });
    // The three ready labels have one colour each.
    assert.deepEqual(colourOfLabel(wanted, "feature-ready"), { colour: "00aa00", chosen: true });
    assert.deepEqual(colourOfLabel(wanted, "task-ready"), { colour: "00bb00", chosen: true });
    assert.deepEqual(colourOfLabel(wanted, "merge-when-ready"), { colour: "00cc00", chosen: true });
    // Renamed, and still coloured.
    assert.deepEqual(colourOfLabel(wanted, "reprendre"), { colour: "ff00ff", chosen: true });
    assert.deepEqual(colourOfLabel(wanted, "termine"), { colour: "0000ff", chosen: true });
    assert.deepEqual(colourOfLabel(wanted, "mason:escalated"), { colour: "d93f0b", chosen: true });
    // Not named: its default, and not chosen.
    assert.deepEqual(colourOfLabel(wanted, "mason:accepted"), { colour: "5319e7", chosen: false });
    assert.deepEqual(colourOfLabel(wanted, "project:app"), { colour: "c5def5", chosen: false });
  });

  it("colours one ready label without touching the other two", () => {
    const wanted = wantedLabels({
      ...LABELS,
      defaultProject: undefined,
      stateLabels: undefined,
      labelColors: colours({ "ticket-ready": "00bb00" }),
    });
    assert.equal(colourOfLabel(wanted, "task-ready")?.chosen, true);
    assert.equal(colourOfLabel(wanted, "feature-ready")?.chosen, false);
    assert.equal(colourOfLabel(wanted, "merge-when-ready")?.chosen, false);
  });

  it("refuses a key that is not something a label is for, and a colour that is not six hex digits", () => {
    const key = resolveLabelColors({ admission: "aa0000" });
    assert.equal(key.ok, false);
    assert.match(key.ok ? "" : key.reason, /not something a label is for/);
    const colour = resolveLabelColors({ "state-done": "green" });
    assert.equal(colour.ok, false);
    assert.match(colour.ok ? "" : colour.reason, /six hex digits/);
  });

  it("creates a missing label with the colour the config chose", async () => {
    const github = githubOf(repositoryOf(), []);
    const result = await setupManager(
      contextOf({ ...LABELS, fetch: github.fetch, labelColors: { resume: "ff00ff" } }),
      { apply: true },
    );
    assert.equal(stateOf(result, "label:to-resume"), "applied");
    const created = github.calls.find((c) => c.method === "POST" && c.body.name === "to-resume");
    assert.equal(created?.body.color, "ff00ff");
  });

  it("recolours an existing label only when the config chose a colour for it", async () => {
    const github = githubOf(repositoryOf(), ["to-resume", "feature-ready", "task-ready"]);
    const options = { ...LABELS, fetch: github.fetch, labelColors: { resume: "ff00ff" } };

    const planned = await setupManager(contextOf(options), { apply: false });
    assert.equal(stateOf(planned, "label:to-resume"), "missing");
    assert.match(detailOf(planned, "label:to-resume"), /ededed.*ff00ff/);
    assert.equal(
      stateOf(planned, "label:feature-ready"),
      "satisfied",
      "no colour chosen: left alone",
    );
    assert.equal(
      github.calls.some((c) => c.method === "PATCH"),
      false,
      "a plan writes nothing",
    );

    const applied = await setupManager(contextOf(options), { apply: true });
    assert.equal(stateOf(applied, "label:to-resume"), "applied");
    const patch = github.calls.find((c) => c.method === "PATCH");
    assert.equal(patch?.path, "/repos/tilap/mason/labels/to-resume");
    assert.equal(patch?.body.color, "ff00ff");

    const again = await setupManager(contextOf(options), { apply: true });
    assert.equal(stateOf(again, "label:to-resume"), "satisfied");
    assert.equal(github.calls.filter((c) => c.method === "PATCH").length, 1);
  });

  it("blocks on a colour it cannot read", async () => {
    const github = githubOf(repositoryOf(), []);
    const result = await setupManager(
      contextOf({ ...LABELS, fetch: github.fetch, labelColors: { resume: "red" } }),
      { apply: false },
    );
    assert.equal(result.ok, false);
  });
});

describe("the no-tests label", () => {
  it("is created for the Ticket side, under the name the config chose, with its own colour", async () => {
    const github = githubOf(repositoryOf(), []);
    await setupManager(
      contextOf(
        { noTestsLabel: "sans-tests", labelColors: { "no-tests": "#FFAA00" }, fetch: github.fetch },
        ["ticketTracker"],
      ),
      { apply: true },
    );
    const created = github.calls.find((c) => c.method === "POST" && c.body.name === "sans-tests");
    assert.equal(created?.body.color, "ffaa00");
  });

  it("is not wanted by the Feature side", () => {
    const names = wantedLabels({
      ...LABELS,
      defaultProject: undefined,
      stateLabels: undefined,
      sides: ["featureTracker"],
    }).map((label) => label.name);
    assert.equal(names.includes("no-tests"), false);
  });

  it("is refused under the Feature side, where it means nothing", async () => {
    const github = githubOf(repositoryOf(), []);
    const result = await setupManager(
      contextOf({ noTestsLabel: "sans-tests", fetch: github.fetch }, ["featureTracker"]),
      { apply: false },
    );
    assert.equal(result.ok, false);
  });
});

describe("the e2e labels", () => {
  it("are created on their own side, under the name the config chose, with their own colour", async () => {
    const github = githubOf(repositoryOf(), []);
    await setupManager(
      contextOf({ e2eLabel: "acceptance", labelColors: { e2e: "#00CC00" }, fetch: github.fetch }, [
        "ticketTracker",
      ]),
      { apply: true },
    );
    const ticket = github.calls.find((c) => c.method === "POST" && c.body.name === "acceptance");
    assert.equal(ticket?.body.color, "00cc00");

    const features = githubOf(repositoryOf(), []);
    await setupManager(
      contextOf(
        {
          skipTestE2eLabel: "sans-e2e",
          labelColors: { "skip-test-e2e": "#FFAA00" },
          fetch: features.fetch,
        },
        ["featureTracker"],
      ),
      { apply: true },
    );
    const feature = features.calls.find((c) => c.method === "POST" && c.body.name === "sans-e2e");
    assert.equal(feature?.body.color, "ffaa00");
  });

  it("are wanted by their own side only", () => {
    const wanted = (sides: ("featureTracker" | "ticketTracker")[]) =>
      wantedLabels({ ...LABELS, defaultProject: undefined, stateLabels: undefined, sides }).map(
        (label) => label.name,
      );
    assert.deepEqual(
      [
        wanted(["ticketTracker"]).includes("e2e"),
        wanted(["ticketTracker"]).includes("skip-test-e2e"),
      ],
      [true, false],
    );
    assert.deepEqual(
      [
        wanted(["featureTracker"]).includes("e2e"),
        wanted(["featureTracker"]).includes("skip-test-e2e"),
      ],
      [false, true],
    );
  });

  it("are refused under the other side, where they mean nothing", async () => {
    const github = githubOf(repositoryOf(), []);
    const ticketOnFeature = await setupManager(
      contextOf({ e2eLabel: "acceptance", fetch: github.fetch }, ["featureTracker"]),
      { apply: false },
    );
    assert.equal(ticketOnFeature.ok, false);
    const featureOnTicket = await setupManager(
      contextOf({ skipTestE2eLabel: "sans-e2e", fetch: github.fetch }, ["ticketTracker"]),
      { apply: false },
    );
    assert.equal(featureOnTicket.ok, false);
  });
});
