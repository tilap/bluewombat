import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ManagerContext } from "@bluewombat/manager-kit";
import {
  checkManager,
  createManager,
  parseAuthor,
  referenceManager,
  scaffoldManager,
} from "./index.js";

function contextOf(
  options: Record<string, unknown>,
  env: Record<string, string | undefined> = {},
): ManagerContext {
  return {
    options,
    durationMs: 1000,
    interruptFlag: { interrupted: false },
    configDir: "/tmp",
    env,
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

describe("scaffoldManager", () => {
  it("fills tracker options and keeps a repo passed in", () => {
    const blank = scaffoldManager(contextOf({}));
    assert.equal(blank.options.repo, "OWNER/REPO");
    assert.deepEqual(blank.options.labels, ["mason"]);
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
  it("fails on a missing token and warns when no label narrows the Source", () => {
    const findings = checkManager(contextOf({ repo: "tilap/mason" }));
    const token = findings.find((finding) => finding.label === "token");
    assert.equal(token?.level, "fail");
    assert.equal(findings.find((finding) => finding.label === "labels")?.level, "warn");
  });

  it("leaves the repository labels to setup", () => {
    const findings = checkManager(
      contextOf({ repo: "tilap/mason", labels: ["mason"] }, { GITHUB_TOKEN: "t" }),
    );
    assert.equal(
      findings.some((finding) => finding.label === "repository labels"),
      false,
    );
  });

  it("warns when the system has no identity of its own on commits, or no token on the remote", () => {
    const bare = checkManager(
      contextOf({ repo: "tilap/mason", labels: ["mason"] }, { GITHUB_TOKEN: "t" }),
    );
    assert.equal(bare.find((finding) => finding.label === "commit author")?.level, "warn");
    assert.equal(bare.find((finding) => finding.label === "git remote")?.level, "ok");

    const ssh = checkManager(
      contextOf(
        {
          repo: "tilap/mason",
          labels: ["mason"],
          remote: "git@github.com:tilap/mason.git",
          commitAuthor: "mason <mason@example.test>",
        },
        { GITHUB_TOKEN: "t" },
      ),
    );
    assert.equal(ssh.find((finding) => finding.label === "commit author")?.level, "ok");
    assert.equal(ssh.find((finding) => finding.label === "git remote")?.level, "warn");
  });

  it("passes once the token is set and labels are named", () => {
    const findings = checkManager(
      contextOf({ repo: "tilap/mason", labels: ["mason"] }, { GITHUB_TOKEN: "t" }),
    );
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
    assert.deepEqual(referenceManager(contextOf({ repo: "tilap/mason-test" })), {
      remote: "https://github.com/tilap/mason-test.git",
      branch: "main",
      credentialEnv: "GITHUB_TOKEN",
    });
  });

  it("takes branch, remote and tokenEnv from the options", () => {
    assert.deepEqual(
      referenceManager(
        contextOf({
          repo: "tilap/mason-test",
          branch: "develop",
          remote: "https://ghe.example.test/tilap/mason-test.git",
          tokenEnv: "GHE_TOKEN",
        }),
      ),
      {
        remote: "https://ghe.example.test/tilap/mason-test.git",
        branch: "develop",
        credentialEnv: "GHE_TOKEN",
      },
    );
  });

  it("names no credential for a remote that is not HTTPS", () => {
    assert.deepEqual(
      referenceManager(
        contextOf({ repo: "tilap/mason-test", remote: "git@github.com:tilap/mason-test.git" }),
      ),
      { remote: "git@github.com:tilap/mason-test.git", branch: "main" },
    );
  });

  it("passes the commit author through, parsed from Name <email>", () => {
    const reference = referenceManager(
      contextOf({ repo: "tilap/mason-test", commitAuthor: "mason <mason@example.test>" }),
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
