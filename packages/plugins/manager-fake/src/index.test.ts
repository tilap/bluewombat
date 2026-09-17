import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ManagerContext } from "@bluewombat/manager-kit";
import { checkManager, createManager, scaffoldManager } from "./index.js";

function contextOf(options: Record<string, unknown>, configDir: string): ManagerContext {
  return {
    options,
    durationMs: 1000,
    interruptFlag: { interrupted: false },
    configDir,
    env: {},
  };
}

function sandbox(): { root: string; source: string } {
  const root = mkdtempSync(join(tmpdir(), "manager-fake-"));
  const source = join(root, "source");
  mkdirSync(source);
  return { root, source };
}

describe("createManager", () => {
  it("resolves relative option paths against the config file and creates the Thread directory", () => {
    const { root } = sandbox();
    const created = createManager(contextOf({ source: "./source", target: "./threads" }, root));
    assert.equal(created.ok, true);
    assert.equal(existsSync(join(root, "threads")), true);
  });

  it("refuses a missing Source, a missing option, and an unknown one", () => {
    const { root, source } = sandbox();
    const missing = createManager(contextOf({ source: "./nope", target: "./threads" }, root));
    assert.equal(missing.ok, false);

    const noTarget = createManager(contextOf({ source }, root));
    assert.equal(noTarget.ok, false);
    assert.match(noTarget.ok === false ? noTarget.reason : "", /"target" is required/);

    const typo = createManager(contextOf({ source, target: "./t", sources: "x" }, root));
    assert.equal(typo.ok, false);
    assert.match(typo.ok === false ? typo.reason : "", /unknown key "sources"/);
  });
});

describe("scaffoldManager", () => {
  it("prepares the default Source and Thread directories", () => {
    const root = mkdtempSync(join(tmpdir(), "manager-fake-scaffold-"));
    const scaffold = scaffoldManager(contextOf({}, root));
    assert.equal(scaffold.options.source, "./.mason/source");
    scaffold.prepare?.(root);
    assert.equal(existsSync(join(root, ".mason/source")), true);
    assert.equal(existsSync(join(root, ".mason/threads")), true);
  });
});

describe("checkManager", () => {
  it("passes on an existing Source and warns about a Thread directory to come", () => {
    const { root, source } = sandbox();
    const findings = checkManager(contextOf({ source, target: "./threads" }, root));
    assert.deepEqual(
      findings.map((finding) => finding.level),
      ["ok", "warn"],
    );
  });

  it("fails once when the options do not read", () => {
    const { root } = sandbox();
    const findings = checkManager(contextOf({}, root));
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.level, "fail");
  });
});
