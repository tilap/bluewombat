import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { strategy as gitStrategy } from "@bluewombat/isolation-git";
import * as github from "@bluewombat/manager-github";
import type { ManagerContext, ManagerModule } from "@bluewombat/manager-kit";
import type { IsolationStrategy } from "../plugins/isolation.js";
import { openHost } from "./open-host.js";
import { materializeWorkLine, resolveWorkLine, type WorkLineInput } from "./work-line.js";

const node = process.execPath;

function sandbox(): string {
  return mkdtempSync(join(tmpdir(), "host-work-line-"));
}

/** A bare remote with one commit on `main`. */
function remoteWith(root: string): string {
  const seed = join(root, "seed");
  mkdirSync(seed);
  writeFileSync(join(seed, "a.txt"), "hello");
  execFileSync("git", ["init", "-b", "main"], { cwd: seed });
  execFileSync("git", ["config", "user.email", "reference@test.local"], { cwd: seed });
  execFileSync("git", ["config", "user.name", "Reference Test"], { cwd: seed });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: seed });
  execFileSync("git", ["add", "."], { cwd: seed });
  execFileSync("git", ["commit", "-m", "init"], { cwd: seed });
  const remote = join(root, "remote.git");
  execFileSync("git", ["clone", "--bare", seed, remote]);
  return remote;
}

const copyStrategy: IsolationStrategy = {
  isolation: {} as IsolationStrategy["isolation"],
  fold: {} as IsolationStrategy["fold"],
};

function resolveWith(over: Partial<WorkLineInput>) {
  const base: WorkLineInput = {
    home: "/install/.mason",
    stable: undefined,
    branch: undefined,
    manager: "@bluewombat/manager-x",
    wantsAuthority: true,
    reference: undefined,
    strategy: gitStrategy,
    strategyName: "@bluewombat/isolation-git",
  };
  return resolveWorkLine({ ...base, ...over });
}

describe("resolveWorkLine", () => {
  it("is the operator's directory when no reference is named", () => {
    const resolved = resolveWith({ stable: "/install/stable" });
    assert.deepEqual(resolved, { kind: "operators", stable: "/install/stable" });
  });

  it("refuses when neither a reference nor workLine.stable says where the work line is", () => {
    const resolved = resolveWith({});
    assert.equal(resolved.kind, "invalid");
    if (resolved.kind === "invalid") {
      assert.match(resolved.reason, /"workLine.stable" is not set/);
      assert.match(resolved.reason, /@bluewombat\/manager-x names no reference/);
    }
  });

  it("is the operator's directory without an Authority, whatever the manager names", () => {
    const resolved = resolveWith({
      stable: "/install/stable",
      wantsAuthority: false,
      reference: { remote: "r", branch: "main" },
    });
    assert.deepEqual(resolved, { kind: "operators", stable: "/install/stable" });
    const unset = resolveWith({
      wantsAuthority: false,
      reference: { remote: "r", branch: "main" },
    });
    assert.equal(unset.kind, "invalid");
    if (unset.kind === "invalid") {
      assert.match(unset.reason, /without an Authority/);
    }
  });

  it("refuses a strategy that cannot keep a copy when nothing else names the directory", () => {
    const resolved = resolveWith({
      reference: { remote: "r", branch: "main" },
      strategy: copyStrategy,
      strategyName: "@bluewombat/isolation-copy",
    });
    assert.equal(resolved.kind, "invalid");
    if (resolved.kind === "invalid") {
      assert.match(resolved.reason, /isolation-copy cannot keep a copy/);
    }
  });

  it("takes an explicit directory as is when the strategy cannot read the reference", () => {
    const resolved = resolveWith({
      stable: "/install/stable",
      reference: { remote: "r", branch: "main" },
      strategy: copyStrategy,
      strategyName: "@bluewombat/isolation-copy",
    });
    assert.equal(resolved.kind, "unchecked");
  });

  it("stops on a key the strategy does not know, before anything is touched", () => {
    const resolved = resolveWith({ reference: { remot: "r", branch: "main" } });
    assert.equal(resolved.kind, "invalid");
    if (resolved.kind === "invalid") {
      assert.match(resolved.reason, /isolation-git cannot read the reference/);
      assert.match(resolved.reason, /unknown key "remot"/);
    }
  });

  it("refuses a workLine.branch that disagrees with the reference", () => {
    const resolved = resolveWith({
      branch: "develop",
      reference: { remote: "r", branch: "main" },
    });
    assert.equal(resolved.kind, "invalid");
    if (resolved.kind === "invalid") {
      assert.match(resolved.reason, /"develop", but .* names "main"/);
    }
  });

  it("places the copy under home and takes the target from the reference", () => {
    const resolved = resolveWith({ reference: { remote: "r", branch: "main" } });
    assert.equal(resolved.kind, "copy");
    if (resolved.kind === "copy") {
      assert.equal(resolved.stable, "/install/.mason/work-line");
      assert.equal(resolved.target, "main");
      assert.equal(resolved.state.kind, "missing");
    }
  });

  it("reads manager-github's reference with isolation-git — the two vocabularies agree", () => {
    const context: ManagerContext = {
      options: { repo: "tilap/mason-test" },
      durationMs: 1000,
      interruptFlag: { interrupted: false },
      configDir: "/install",
      env: {},
    };
    const resolved = resolveWith({ reference: github.referenceManager(context) });
    assert.equal(resolved.kind, "copy");
    if (resolved.kind === "copy") {
      assert.equal(resolved.target, "main");
      assert.equal(resolved.reference.summary, "https://github.com/tilap/mason-test.git (main)");
      // The words the manager chose for identity and credentials are read too.
      assert.equal(resolved.reference.env?.GIT_CONFIG_KEY_1, "credential.helper");
      assert.match(resolved.reference.env?.GIT_CONFIG_VALUE_1 ?? "", /GITHUB_TOKEN/);
    }
  });
});

describe("materializeWorkLine", () => {
  it("fetches a missing copy once, then finds it matching", async () => {
    const root = sandbox();
    const remote = remoteWith(root);
    const home = join(root, ".mason");
    const first = resolveWith({ home, reference: { remote, branch: "main" } });
    assert.equal(first.kind, "copy");
    if (first.kind !== "copy") {
      return;
    }
    const made = await materializeWorkLine(first);
    assert.deepEqual(made, { ok: true, fetched: true });
    assert.equal(existsSync(join(home, "work-line", ".git")), true);

    const second = resolveWith({ home, reference: { remote, branch: "main" } });
    assert.equal(second.kind, "copy");
    if (second.kind === "copy") {
      assert.equal(second.state.kind, "matches");
      assert.deepEqual(await materializeWorkLine(second), { ok: true, fetched: false });
    }
  });

  it("refuses a directory that is not a copy of the reference", async () => {
    const root = sandbox();
    const remote = remoteWith(root);
    const stable = join(root, "elsewhere");
    mkdirSync(stable);
    const resolved = resolveWith({ stable, reference: { remote, branch: "main" } });
    assert.equal(resolved.kind, "copy");
    if (resolved.kind === "copy") {
      const made = await materializeWorkLine(resolved);
      assert.equal(made.ok, false);
      if (!made.ok) {
        assert.match(made.reason, /is not a copy of/);
        assert.match(made.reason, /not a git tree/);
      }
    }
  });
});

/** A manager that names a reference in whatever words the test wants. */
function moduleNaming(reference: Record<string, unknown>): ManagerModule {
  return {
    createManager() {
      return {
        ok: true,
        manager: {
          async listen() {
            return { outcome: "listened", deliveries: [] };
          },
          async adapt() {
            return { outcome: "unavailable" };
          },
          async report() {
            return true;
          },
          async submit() {
            return { outcome: "unavailable" as const };
          },
          async fold() {
            return { outcome: "unavailable" as const };
          },
        },
      };
    },
    referenceManager: () => reference,
  };
}

function bootOptions(root: string, manager: ManagerModule) {
  return {
    manager,
    configDir: root,
    workLineIsolation: "@bluewombat/isolation-git",
    workspaceRoot: join(root, ".mason", "workspaces"),
    ledgerRoot: join(root, ".mason", "ledger"),
    planner: { cmd: [node, "-e", ""], timeoutMs: 1000, gates: [] },
    builder: {
      producer: { cmd: [node, "-e", ""], timeoutMs: 1000, gates: [] },
      repair: { cmd: [node, "-e", ""], timeoutMs: 1000, gates: [] },
    },
    assembly: { gates: [] },
    authority: { enabled: true, publishArgv: [node, "-e", ""], refreshArgv: [node, "-e", ""] },
    timeoutMs: 1000,
    write: () => {},
  };
}

describe("openHost with a reference work line", () => {
  it("stops on a mistyped key before the ledger or the workspaces exist", async () => {
    const root = sandbox();
    await assert.rejects(
      openHost(bootOptions(root, moduleNaming({ remot: "x", branch: "main" }))),
      /unknown key "remot"/,
    );
    assert.equal(existsSync(join(root, ".mason")), false);
  });

  it("stops on a branch the remote does not have, before anything is written", async () => {
    const root = sandbox();
    const remote = remoteWith(root);
    await assert.rejects(
      openHost(bootOptions(root, moduleNaming({ remote, branch: "develop" }))),
      /no branch "develop"/,
    );
    assert.equal(existsSync(join(root, ".mason")), false);
  });

  it("copies the reference under .mason/work-line and takes the target from it", async () => {
    const root = sandbox();
    const remote = remoteWith(root);
    const lines: string[] = [];
    await openHost({
      ...bootOptions(root, moduleNaming({ remote, branch: "main" })),
      write: (text) => {
        lines.push(text);
      },
    });
    const copy = join(root, ".mason", "work-line");
    assert.equal(existsSync(join(copy, "a.txt")), true);
    assert.equal(
      execFileSync("git", ["symbolic-ref", "--short", "HEAD"], {
        cwd: copy,
        encoding: "utf8",
      }).trim(),
      "main",
    );
    assert.ok(lines.some((line) => line.includes("copied") && line.includes(copy)));
  });
});
