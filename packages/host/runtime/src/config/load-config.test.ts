import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { stringify as stringifyYaml } from "yaml";
import { loadConfig } from "./load-config.js";

function load(config: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "host-load-"));
  const file = join(dir, "mason.config.yaml");
  writeFileSync(file, stringifyYaml(config));
  return loadConfig(file);
}

const side = { package: "@acme/manager", options: { repo: "owner/name" } };

describe("the two sides of the config", () => {
  it("reads featureTracker and ticketTracker", () => {
    const loaded = load({ featureTracker: side, ticketTracker: side });
    assert.equal(loaded.ok, true);
    if (loaded.ok) {
      assert.equal(loaded.invocation.featureTracker?.package, "@acme/manager");
      assert.equal(loaded.invocation.ticketTracker?.package, "@acme/manager");
    }
  });

  it("refuses a key it does not know", () => {
    const loaded = load({ featureTracker: side, ticketTracker: side, other: 1 });
    assert.equal(loaded.ok, false);
    assert.match(loaded.ok ? "" : loaded.reason, /unknown key "other"/);
  });
});
