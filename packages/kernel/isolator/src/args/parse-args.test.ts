import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { parseArgs } from "./parse-args.js";

function parentDir(): string {
  const root = mkdtempSync(join(tmpdir(), "isolator-args-"));
  const parent = join(root, "parent");
  mkdirSync(parent);
  writeFileSync(join(parent, "a.txt"), "a");
  return parent;
}

function childPath(parent: string, name = "child"): string {
  return join(parent, "..", name);
}

function validArgs(over: string[] = []): string[] {
  const parent = parentDir();
  return [
    "--id",
    "feat-1",
    "--parent",
    parent,
    "--child",
    childPath(parent),
    "--duration-ms",
    "1000",
    "--strategy",
    "@bluewombat/isolation-copy",
    ...over,
  ];
}

describe("parseArgs", () => {
  it("parses a minimal valid invocation", () => {
    const parent = parentDir();
    const child = childPath(parent);
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
    const result = parseArgs([...validArgs(), "--on-status", "--", "node", "hook.js"]);
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.deepEqual(result.invocation.onStatusArgv, ["node", "hook.js"]);
  });

  it("rejects an empty --id", () => {
    const parent = parentDir();
    const result = parseArgs([
      "--id",
      "",
      "--parent",
      parent,
      "--child",
      childPath(parent),
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
    const result = parseArgs([
      "--id",
      "feat-1",
      "--parent",
      "relative/parent",
      "--child",
      "/tmp/isolator-child-xyz",
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
    const root = mkdtempSync(join(tmpdir(), "isolator-args-"));
    const result = parseArgs([
      "--id",
      "feat-1",
      "--parent",
      join(root, "missing"),
      "--child",
      join(root, "child"),
      "--duration-ms",
      "1",
      "--strategy",
      "@bluewombat/isolation-copy",
    ]);
    assert.equal(result.ok, false);
  });

  it("rejects a Child that already exists", () => {
    const parent = parentDir();
    const child = childPath(parent);
    mkdirSync(child);
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

  it("accepts a Child whose containing directory is missing", () => {
    const parent = parentDir();
    const result = parseArgs([
      "--id",
      "feat-1",
      "--parent",
      parent,
      "--child",
      join(parent, "..", "no-such-dir", "child"),
      "--duration-ms",
      "1",
      "--strategy",
      "@bluewombat/isolation-copy",
    ]);
    assert.equal(result.ok, true);
  });

  it("rejects Child inside Parent", () => {
    const parent = parentDir();
    const result = parseArgs([
      "--id",
      "feat-1",
      "--parent",
      parent,
      "--child",
      join(parent, "nested-child"),
      "--duration-ms",
      "1",
      "--strategy",
      "@bluewombat/isolation-copy",
    ]);
    assert.equal(result.ok, false);
  });

  it("rejects a Child path that already exists as an ancestor of Parent", () => {
    const root = mkdtempSync(join(tmpdir(), "isolator-args-"));
    const childContainer = join(root, "outer");
    mkdirSync(childContainer);
    const parent = join(childContainer, "parent");
    mkdirSync(parent);
    const result = parseArgs([
      "--id",
      "feat-1",
      "--parent",
      parent,
      "--child",
      childContainer,
      "--duration-ms",
      "1",
      "--strategy",
      "@bluewombat/isolation-copy",
    ]);
    assert.equal(result.ok, false);
  });

  it("rejects the same Parent and Child path", () => {
    const parent = parentDir();
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
    const parent = parentDir();
    const result = parseArgs([
      "--id",
      "feat-1",
      "--parent",
      parent,
      "--child",
      childPath(parent),
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
