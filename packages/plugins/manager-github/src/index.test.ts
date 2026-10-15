import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EVENT_NAMES, type ManagerContext } from "@bluewombat/manager-kit";
import {
  checkManager,
  createManager,
  parseAuthor,
  referenceManager,
  scaffoldManager,
  setupManager,
} from "./index.js";

function contextOf(
  options: Record<string, unknown>,
  env: Record<string, string | undefined> = {},
  sides?: ManagerContext["sides"],
): ManagerContext {
  return {
    options,
    durationMs: 1000,
    interruptFlag: { interrupted: false },
    configDir: "/tmp",
    env,
    ...(sides !== undefined ? { sides } : {}),
  };
}

describe("createManager", () => {
  it("reads the token from the environment variable the options name", () => {
    const created = createManager(
      contextOf({ repo: "tilap/mason", tokenEnv: "MASON_TOKEN" }, { MASON_TOKEN: "t" }),
    );
    assert.equal(created.ok, true);
  });

  it("names the variable it wanted when no token is set", () => {
    const created = createManager(contextOf({ repo: "tilap/mason" }));
    assert.equal(created.ok, false);
    assert.match(created.ok === false ? created.reason : "", /GITHUB_TOKEN/);
  });

  it("refuses a missing repo, a malformed one, and an unknown option", () => {
    assert.equal(createManager(contextOf({}, { GITHUB_TOKEN: "t" })).ok, false);
    const malformed = createManager(contextOf({ repo: "nope" }, { GITHUB_TOKEN: "t" }));
    assert.equal(malformed.ok, false);
    assert.match(malformed.ok === false ? malformed.reason : "", /owner\/name/);
    const typo = createManager(contextOf({ repo: "a/b", repos: "c" }, { GITHUB_TOKEN: "t" }));
    assert.equal(typo.ok, false);
    assert.match(typo.ok === false ? typo.reason : "", /unknown key "repos"/);
  });
});

describe("options that belong to one side", () => {
  const env = { GITHUB_TOKEN: "t" };

  it("takes the Feature labels under featureTracker and the Ticket label under ticketTracker", () => {
    const feature = createManager(
      contextOf({ repo: "tilap/mason", featureReadyLabel: "f", mergeWhenReadyLabel: "m" }, env, [
        "featureTracker",
      ]),
    );
    const ticket = createManager(
      contextOf({ repo: "tilap/mason", ticketReadyLabel: "t" }, env, ["ticketTracker"]),
    );
    assert.equal(feature.ok, true);
    assert.equal(ticket.ok, true);
  });

  it("refuses a Ticket label under featureTracker, and a Feature label under ticketTracker", () => {
    const wrongTicket = createManager(
      contextOf({ repo: "tilap/mason", ticketReadyLabel: "t" }, env, ["featureTracker"]),
    );
    assert.equal(wrongTicket.ok, false);
    assert.match(
      wrongTicket.ok === false ? wrongTicket.reason : "",
      /"ticketReadyLabel" belongs under ticketTracker, not under featureTracker/,
    );
    for (const name of ["featureReadyLabel", "mergeWhenReadyLabel"]) {
      const wrongFeature = createManager(
        contextOf({ repo: "tilap/mason", [name]: "x" }, env, ["ticketTracker"]),
      );
      assert.equal(wrongFeature.ok, false);
      assert.match(
        wrongFeature.ok === false ? wrongFeature.reason : "",
        new RegExp(`"${name}" belongs under featureTracker`),
      );
    }
  });

  it("takes every label when one manager holds both sides, or when no side is named", () => {
    const all = { repo: "tilap/mason", featureReadyLabel: "f", ticketReadyLabel: "t" };
    assert.equal(createManager(contextOf(all, env)).ok, true);
    assert.equal(createManager(contextOf(all, env, ["featureTracker", "ticketTracker"])).ok, true);
  });

  it("names, in doctor, only the labels of the side it serves", () => {
    const ticket = checkManager(contextOf({ repo: "tilap/mason" }, env, ["ticketTracker"]));
    const detail = ticket.find((finding) => finding.label === "labels")?.detail ?? "";
    assert.match(detail, /task-ready \(Ticket\)/);
    assert.doesNotMatch(detail, /feature-ready|merge-when-ready/);
    const feature = checkManager(contextOf({ repo: "tilap/mason" }, env, ["featureTracker"]));
    const featureDetail = feature.find((finding) => finding.label === "labels")?.detail ?? "";
    assert.match(featureDetail, /feature-ready \(Feature\).*merge-when-ready \(Feature\)/);
    assert.doesNotMatch(featureDetail, /task-ready/);
  });
});

describe("a resume label of its own on each side", () => {
  const env = { GITHUB_TOKEN: "t" };
  const carries = (name: string) => ({ number: 7, labels: [{ name }] });

  it("reads the Feature's resume label on the feature side, whatever the ticket side calls its own", () => {
    const created = createManager(
      contextOf({ repo: "tilap/mason", resumeLabel: "ready" }, env, ["featureTracker"]),
    );
    assert.equal(created.ok, true);
    const features = created.ok ? created.manager.features : undefined;
    assert.equal(features?.signalsResume?.(carries("ready")), true);
    assert.equal(features?.signalsResume?.(carries("pretgo")), false);
  });

  it("takes back the Ticket's own resume label, not the Feature's", async () => {
    const deleted: string[] = [];
    const fetch = (async (input: unknown, init: { method?: string } = {}) => {
      if (String(init.method ?? "GET").toUpperCase() === "DELETE") {
        deleted.push(decodeURIComponent(new URL(String(input)).pathname));
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof globalThis.fetch;
    const created = createManager(
      contextOf({ repo: "tilap/mason", resumeLabel: "pretgo", fetch }, env, ["ticketTracker"]),
    );
    assert.equal(created.ok, true);
    await (created.ok
      ? created.manager.tickets?.clearResume?.("github:tilap/mason#42")
      : undefined);
    assert.deepEqual(deleted, ["/repos/tilap/mason/issues/42/labels/pretgo"]);
  });
});

describe("the stateLabels option", () => {
  const env = { GITHUB_TOKEN: "t" };
  const named = (over: Record<string, unknown> = {}) => ({
    ...Object.fromEntries(EVENT_NAMES.map((event) => [event, `mason:${event}`])),
    ...over,
  });

  it("takes a mapping that names every Event", () => {
    const created = createManager(
      contextOf({ repo: "tilap/mason", stateLabels: named({ done: "termine" }) }, env),
    );
    assert.equal(created.ok, true);
  });

  it("refuses what is not a mapping of non-empty labels, or not an Event", () => {
    for (const stateLabels of [
      "done",
      ["done"],
      named({ done: "" }),
      named({ done: 3 }),
      named({ planned: "x" }),
    ]) {
      const created = createManager(contextOf({ repo: "tilap/mason", stateLabels }, env));
      assert.equal(created.ok, false, JSON.stringify(stateLabels));
    }
  });

  it("asks for every Event", () => {
    const created = createManager(
      contextOf({ repo: "tilap/mason", stateLabels: { done: "termine" } }, env),
    );
    assert.equal(created.ok, false);
    assert.match(created.ok === false ? created.reason : "", /must name every event/);
  });

  it("refuses stateLabelPrefix, which is not an option", () => {
    const created = createManager(
      contextOf({ repo: "tilap/mason", stateLabelPrefix: "mason:" }, env),
    );
    assert.equal(created.ok, false);
  });

  it("is named by doctor, off when nothing asks for state labels", () => {
    const off = checkManager(contextOf({ repo: "tilap/mason" }, env));
    assert.match(off.find((f) => f.label === "state labels")?.detail ?? "", /^off/);
    const on = checkManager(
      contextOf({ repo: "tilap/mason", stateLabels: named({ done: "termine" }) }, env),
    );
    const detail = on.find((f) => f.label === "state labels")?.detail ?? "";
    assert.match(detail, /mason:accepted/);
    assert.match(detail, /termine/);
    assert.doesNotMatch(detail, /mason:done/);
  });
});

describe("state labels of their own on each side", () => {
  const env = { GITHUB_TOKEN: "t" };
  const named = (label: (event: string) => string) =>
    Object.fromEntries(EVENT_NAMES.map((event) => [event, label(event)]));

  it("puts a Feature's Event under the feature labels and a Ticket's under the ticket labels", async () => {
    const posted: { path: string; labels: unknown }[] = [];
    const fetch = (async (input: unknown, init: { method?: string; body?: unknown } = {}) => {
      const method = String(init.method ?? "GET").toUpperCase();
      const path = new URL(String(input)).pathname;
      if (method === "POST" && path.endsWith("/comments")) {
        return new Response(JSON.stringify({ id: 1, html_url: "https://github.com/x#c1" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "POST" && path.endsWith("/labels") && typeof init.body === "string") {
        posted.push({ path, labels: JSON.parse(init.body).labels });
      }
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof globalThis.fetch;
    const feature = createManager(
      contextOf(
        { repo: "tilap/mason", stateLabels: named((event) => `feature:${event}`), fetch },
        env,
        ["featureTracker"],
      ),
    );
    const ticket = createManager(
      contextOf(
        { repo: "tilap/mason", stateLabels: named((event) => `task:${event}`), fetch },
        env,
        ["ticketTracker"],
      ),
    );
    assert.ok(feature.ok && ticket.ok);
    if (!(feature.ok && ticket.ok)) {
      return;
    }
    const input = { project: "app", event: "done" as const, fields: { reference: "r1" } };
    await feature.manager.features?.report({ ...input, key: "github:tilap/mason#10" });
    await ticket.manager.tickets?.report({ ...input, key: "github:tilap/mason#42" });
    assert.deepEqual(posted, [
      { path: "/repos/tilap/mason/issues/10/labels", labels: ["feature:done"] },
      { path: "/repos/tilap/mason/issues/42/labels", labels: ["task:done"] },
    ]);
  });

  it("creates only that side's names, from the same options", async () => {
    for (const [side, prefix] of [
      ["featureTracker", "feature:"],
      ["ticketTracker", "task:"],
    ] as const) {
      const created: string[] = [];
      const fetch = (async (input: unknown, init: { method?: string; body?: unknown } = {}) => {
        const method = String(init.method ?? "GET").toUpperCase();
        const path = new URL(String(input)).pathname;
        if (method === "POST" && path.endsWith("/labels") && typeof init.body === "string") {
          created.push(JSON.parse(init.body).name);
        }
        const body =
          path === "/repos/tilap/mason"
            ? { has_issues: true, permissions: { push: true } }
            : path.includes("/branches/")
              ? { name: "main" }
              : [];
        return new Response(JSON.stringify(body), {
          status: method === "POST" ? 201 : 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof globalThis.fetch;
      await setupManager(
        contextOf(
          {
            repo: "tilap/mason",
            token: "t",
            stateLabels: named((event) => `${prefix}${event}`),
            fetch,
          },
          env,
          [side],
        ),
        { apply: true },
      );
      assert.ok(created.includes(`${prefix}done`), side);
      assert.equal(
        created.some((name) => name.startsWith(prefix === "feature:" ? "task:" : "feature:")),
        false,
        side,
      );
    }
  });
});

describe("scaffoldManager", () => {
  it("fills tracker options and keeps a repo passed in", () => {
    const blank = scaffoldManager(contextOf({}));
    assert.equal(blank.options.repo, "OWNER/REPO");
    assert.equal(blank.options.labels, undefined);
    assert.match(blank.nextSteps.join("\n"), /GITHUB_TOKEN/);

    const named = scaffoldManager(contextOf({ repo: "tilap/mason" }));
    assert.equal(named.options.repo, "tilap/mason");
    assert.equal(
      named.nextSteps.some((step) => step.includes("managerOptions.repo")),
      false,
    );
  });

  it("names the variable the operator chose, not the default", () => {
    // `init` asks for tokenEnv, then calls this again with the answer. Telling
    // that operator to export GITHUB_TOKEN sends them to the wrong variable —
    // and, for anyone splitting an agent account off their own, to a `gh` that
    // reads GITHUB_TOKEN ahead of its stored login.
    const chosen = scaffoldManager(contextOf({ repo: "tilap/mason", tokenEnv: "MASON_TOKEN" }));
    assert.equal(chosen.options.tokenEnv, "MASON_TOKEN");
    assert.match(chosen.nextSteps.join("\n"), /MASON_TOKEN/);
    assert.equal(
      chosen.nextSteps.some((step) => step.includes("GITHUB_TOKEN")),
      false,
    );
  });
});

describe("checkManager", () => {
  it("fails on a missing token, and names the labels it will look for", () => {
    const findings = checkManager(contextOf({ repo: "tilap/mason" }));
    const token = findings.find((finding) => finding.label === "token");
    assert.equal(token?.level, "fail");
    const labels = findings.find((finding) => finding.label === "labels");
    assert.equal(labels?.level, "ok");
    for (const name of ["feature-ready", "task-ready", "merge-when-ready", "to-resume (resume)"]) {
      assert.ok(labels?.detail?.includes(name), `doctor names ${name}`);
    }
  });

  it("leaves the repository labels to setup", () => {
    const findings = checkManager(contextOf({ repo: "tilap/mason" }, { GITHUB_TOKEN: "t" }));
    assert.equal(
      findings.some((finding) => finding.label === "repository labels"),
      false,
    );
  });

  it("warns when the system has no identity of its own on commits, or no token on the remote", () => {
    const bare = checkManager(contextOf({ repo: "tilap/mason" }, { GITHUB_TOKEN: "t" }));
    assert.equal(bare.find((finding) => finding.label === "commit author")?.level, "warn");
    assert.equal(bare.find((finding) => finding.label === "git remote")?.level, "ok");

    const ssh = checkManager(
      contextOf(
        {
          repo: "tilap/mason",
          remote: "git@github.com:tilap/mason.git",
          commitAuthor: "mason <mason@example.test>",
        },
        { GITHUB_TOKEN: "t" },
      ),
    );
    assert.equal(ssh.find((finding) => finding.label === "commit author")?.level, "ok");
    assert.equal(ssh.find((finding) => finding.label === "git remote")?.level, "warn");
  });

  it("passes once the token is set", () => {
    const findings = checkManager(contextOf({ repo: "tilap/mason" }, { GITHUB_TOKEN: "t" }));
    assert.equal(
      findings.some((finding) => finding.level === "fail"),
      false,
    );
  });
});

describe("referenceManager", () => {
  it("names the repository's HTTPS remote, main, and the token variable by default", () => {
    // HTTPS with the API token: the push is the token's account, not this
    // machine's SSH key, and the strategy reads the variable when git asks.
    assert.deepEqual(referenceManager(contextOf({ repo: "owner/repo" })), {
      remote: "https://github.com/owner/repo.git",
      branch: "main",
      credentialEnv: "GITHUB_TOKEN",
    });
  });

  it("takes branch, remote and tokenEnv from the options", () => {
    assert.deepEqual(
      referenceManager(
        contextOf({
          repo: "owner/repo",
          branch: "develop",
          remote: "https://ghe.example.test/owner/repo.git",
          tokenEnv: "GHE_TOKEN",
        }),
      ),
      {
        remote: "https://ghe.example.test/owner/repo.git",
        branch: "develop",
        credentialEnv: "GHE_TOKEN",
      },
    );
  });

  it("names no credential for a remote that is not HTTPS", () => {
    assert.deepEqual(
      referenceManager(contextOf({ repo: "owner/repo", remote: "git@github.com:owner/repo.git" })),
      { remote: "git@github.com:owner/repo.git", branch: "main" },
    );
  });

  it("passes the commit author through, parsed from Name <email>", () => {
    const reference = referenceManager(
      contextOf({ repo: "owner/repo", commitAuthor: "mason <mason@example.test>" }),
    );
    assert.deepEqual(reference?.author, { name: "mason", email: "mason@example.test" });
  });

  it("names nothing when the options do not read", () => {
    assert.equal(referenceManager(contextOf({ repo: "nope" })), undefined);
  });
});

describe("parseAuthor", () => {
  it("reads Name <email> and refuses anything else", () => {
    assert.deepEqual(parseAuthor("mason <mason@example.test>"), {
      ok: true,
      value: { name: "mason", email: "mason@example.test" },
    });
    assert.deepEqual(parseAuthor("  Neryn Vale  <neryn@example.test>  ").ok, true);
    for (const bad of ["mason", "<mason@example.test>", "mason <not-an-email>", ""]) {
      assert.equal(parseAuthor(bad).ok, false, bad);
    }
    const refused = createManager(
      contextOf({ repo: "tilap/mason", commitAuthor: "mason" }, { GITHUB_TOKEN: "t" }),
    );
    assert.equal(refused.ok, false);
  });
});
