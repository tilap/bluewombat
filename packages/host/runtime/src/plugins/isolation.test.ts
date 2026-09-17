import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { resolveIsolationStrategy } from "./isolation.js";

function strategyFile(body: string): { root: string; name: string } {
  const root = mkdtempSync(join(tmpdir(), "strategy-"));
  writeFileSync(join(root, "strategy.mjs"), body);
  return { root, name: "./strategy.mjs" };
}

const backends = "isolation: {}, fold: {}";

describe("resolveIsolationStrategy", () => {
  it("loads an installed strategy by name, with what it exports", async () => {
    const resolved = await resolveIsolationStrategy("@bluewombat/isolation-git", process.cwd());
    assert.ok(resolved.ok);
    assert.equal(typeof resolved.strategy.isolation, "object");
    assert.equal(typeof resolved.strategy.fold, "object");
    assert.equal(typeof resolved.strategy.reference?.parse, "function");
    assert.equal(typeof resolved.strategy.refOf, "function");
  });

  it("takes a strategy with neither reference nor refOf", async () => {
    const { root, name } = strategyFile(`export const strategy = { ${backends} };\n`);
    const resolved = await resolveIsolationStrategy(name, root);
    assert.ok(resolved.ok);
    assert.equal(resolved.strategy.reference, undefined);
    assert.equal(resolved.strategy.refOf, undefined);
  });

  it("refuses a module without strategy, or a strategy without both backends", async () => {
    for (const body of [
      "export const nothing = 1;\n",
      "export const strategy = { isolation: {} };\n",
      "export const strategy = { fold: {} };\n",
    ]) {
      const { root, name } = strategyFile(body);
      const resolved = await resolveIsolationStrategy(name, root);
      assert.ok(!resolved.ok);
      assert.match(resolved.reason, /does not export strategy/);
    }
  });

  it("refuses a reference that cannot parse", async () => {
    const { root, name } = strategyFile(
      `export const strategy = { ${backends}, reference: {} };\n`,
    );
    const resolved = await resolveIsolationStrategy(name, root);
    assert.ok(!resolved.ok);
    assert.match(resolved.reason, /exports a reference without parse/);
  });

  it("hands isolationOptions to createStrategy, and refuses them where there is none", async () => {
    const shaped = await resolveIsolationStrategy("@bluewombat/isolation-git", process.cwd(), {
      exclude: ["secrets/**"],
    });
    assert.ok(shaped.ok, shaped.ok ? "" : shaped.reason);
    assert.equal(typeof shaped.strategy.isolation, "object");

    const refused = await resolveIsolationStrategy("@bluewombat/isolation-git", process.cwd(), {
      excludes: [".env"],
    });
    assert.equal(refused.ok, false);
    assert.match(refused.ok ? "" : refused.reason, /"excludes" is not one/);

    const { root, name } = strategyFile(`export const strategy = { ${backends} };\n`);
    const plain = await resolveIsolationStrategy(name, root, { anything: 1 });
    assert.equal(plain.ok, false);
    assert.match(plain.ok ? "" : plain.reason, /takes no isolationOptions/);

    const notFn = strategyFile(
      `export const strategy = { ${backends} }; export const createStrategy = 1;\n`,
    );
    const bad = await resolveIsolationStrategy(notFn.name, notFn.root);
    assert.equal(bad.ok, false);
    assert.match(bad.ok ? "" : bad.reason, /createStrategy that is not a function/);
  });

  it("refuses a refOf that is not a function", async () => {
    const { root, name } = strategyFile(
      `export const strategy = { ${backends}, refOf: "main" };\n`,
    );
    const resolved = await resolveIsolationStrategy(name, root);
    assert.ok(!resolved.ok);
    assert.match(resolved.reason, /exports a refOf that is not a function/);
  });
});
