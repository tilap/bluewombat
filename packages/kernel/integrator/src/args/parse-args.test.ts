import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { parseArgs } from "./parse-args.js";

function pair(): { parent: string; child: string } {
  const root = mkdtempSync(join(tmpdir(), "integrator-args-"));
  const parent = join(root, "parent");
  const child = join(root, "child");
  mkdirSync(parent);
  mkdirSync(child);
  writeFileSync(join(parent, "a.txt"), "a");
  writeFileSync(join(child, "b.txt"), "b");
  return { parent, child };
}

describe("parseArgs", () => {
  it("parses a minimal valid invocation", () => {
    const { parent, child } = pair();
    const result = parseArgs([
      "--id",
      "feat-1",
      "--parent",
      parent,
      "--child",
      child,
      "--duration-ms",
      "1000",
      "--strategy",
      "@bluewombat/isolation-copy",
    ]);
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.invocation.id, "feat-1");
    assert.equal(result.invocation.parent, resolve(parent));
    assert.equal(result.invocation.child, resolve(child));
    assert.equal(result.invocation.durationMs, 1000);
    assert.equal(result.invocation.onStatusArgv, undefined);
  });

  it("parses --on-status", () => {
    const { parent, child } = pair();
    const result = parseArgs([
      "--id",
      "feat-1",
      "--parent",
      parent,
      "--child",
      child,
      "--duration-ms",
      "1000",
      "--strategy",
      "@bluewombat/isolation-copy",
      "--on-status",
      "--",
      "node",
      "hook.js",
    ]);
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.deepEqual(result.invocation.onStatusArgv, ["node", "hook.js"]);
  });

  it("rejects an empty --id", () => {
    const { parent, child } = pair();
    const result = parseArgs([
      "--id",
      "",
      "--parent",
      parent,
      "--child",
      child,
      "--duration-ms",
      "1",
      "--strategy",
      "@bluewombat/isolation-copy",
    ]);
    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.equal(result.id, undefined);
  });

  it("rejects a relative --parent", () => {
    const { child } = pair();
    const result = parseArgs([
      "--id",
      "feat-1",
      "--parent",
      "relative/parent",
      "--child",
      child,
      "--duration-ms",
      "1",
      "--strategy",
      "@bluewombat/isolation-copy",
    ]);
    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.equal(result.id, "feat-1");
  });

  it("rejects a missing Parent", () => {
    const root = mkdtempSync(join(tmpdir(), "integrator-args-"));
    const child = join(root, "child");
    mkdirSync(child);
    const result = parseArgs([
      "--id",
      "feat-1",
      "--parent",
      join(root, "missing"),
      "--child",
      child,
      "--duration-ms",
      "1",
      "--strategy",
      "@bluewombat/isolation-copy",
    ]);
    assert.equal(result.ok, false);
  });

  it("rejects a missing Child", () => {
    const root = mkdtempSync(join(tmpdir(), "integrator-args-"));
    const parent = join(root, "parent");
    mkdirSync(parent);
    const result = parseArgs([
      "--id",
      "feat-1",
      "--parent",
      parent,
      "--child",
      join(root, "missing"),
      "--duration-ms",
      "1",
      "--strategy",
      "@bluewombat/isolation-copy",
    ]);
    assert.equal(result.ok, false);
  });

  it("rejects Child inside Parent", () => {
    const { parent } = pair();
    const nested = join(parent, "nested-child");
    mkdirSync(nested);
    const result = parseArgs([
      "--id",
      "feat-1",
      "--parent",
      parent,
      "--child",
      nested,
      "--duration-ms",
      "1",
      "--strategy",
      "@bluewombat/isolation-copy",
    ]);
    assert.equal(result.ok, false);
  });

  it("rejects Parent inside Child", () => {
    const root = mkdtempSync(join(tmpdir(), "integrator-args-"));
    const child = join(root, "child");
    const parent = join(child, "parent");
    mkdirSync(child);
    mkdirSync(parent);
    const result = parseArgs([
      "--id",
      "feat-1",
      "--parent",
      parent,
      "--child",
      child,
      "--duration-ms",
      "1",
      "--strategy",
      "@bluewombat/isolation-copy",
    ]);
    assert.equal(result.ok, false);
  });

  it("rejects the same Parent and Child path", () => {
    const { parent } = pair();
    const result = parseArgs([
      "--id",
      "feat-1",
      "--parent",
      parent,
      "--child",
      parent,
      "--duration-ms",
      "1",
      "--strategy",
      "@bluewombat/isolation-copy",
    ]);
    assert.equal(result.ok, false);
  });

  it("rejects a non-positive --duration-ms", () => {
    const { parent, child } = pair();
    const result = parseArgs([
      "--id",
      "feat-1",
      "--parent",
      parent,
      "--child",
      child,
      "--duration-ms",
      "0",
      "--strategy",
      "@bluewombat/isolation-copy",
    ]);
    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.equal(result.id, "feat-1");
  });
});
