import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { runIntegrator } from "@bluewombat/integrator";
import { runIsolator } from "@bluewombat/isolator";
import { strategy } from "./index.js";

function sandbox(): string {
  return mkdtempSync(join(tmpdir(), "isolation-copy-"));
}

function writeTree(root: string, files: Record<string, string>): void {
  mkdirSync(root, { recursive: true });
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

describe("isolation-copy strategy", () => {
  it("isolates by directory copy without .git", async () => {
    const root = sandbox();
    const parent = join(root, "parent");
    writeTree(parent, { "a.txt": "plain" });
    const child = join(root, "child");
    const result = await runIsolator({
      backend: strategy.isolation,
      invocation: { id: "feat-1", parent, child, durationMs: 30_000 },
      write: () => {},
    });
    assert.equal(result.outcome, "isolated");
    assert.equal(existsSync(join(child, ".git")), false);
    assert.equal(readFileSync(join(child, "a.txt"), "utf8"), "plain");
    writeFileSync(join(child, "only-child.txt"), "c");
    assert.equal(existsSync(join(parent, "only-child.txt")), false);
  });

  it("folds same-type bytes from Child", async () => {
    const root = sandbox();
    const parent = join(root, "parent");
    const child = join(root, "child");
    writeTree(parent, { "a.txt": "parent" });
    writeTree(child, { "a.txt": "child" });
    const result = await runIntegrator({
      backend: strategy.fold,
      invocation: { id: "feat-1", parent, child, durationMs: 30_000 },
      write: () => {},
    });
    assert.equal(result.outcome, "integrated");
    assert.equal(readFileSync(join(parent, "a.txt"), "utf8"), "child");
  });

  it("copy does not apply a Child deletion", async () => {
    const root = sandbox();
    const parent = join(root, "parent");
    const child = join(root, "child");
    writeTree(parent, { "keep.txt": "parent", "gone.txt": "still here" });
    writeTree(child, { "keep.txt": "parent" });
    const result = await runIntegrator({
      backend: strategy.fold,
      invocation: { id: "feat-1", parent, child, durationMs: 30_000 },
      write: () => {},
    });
    assert.equal(result.outcome, "integrated");
    assert.equal(readFileSync(join(parent, "gone.txt"), "utf8"), "still here");
  });
});
