import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { HostInvocation } from "../config/types.js";
import { redact, systemOf } from "./incident-system.js";

function invocation(dir: string): HostInvocation {
  return {
    featureTracker: { package: "@bluewombat/manager-fake", options: {} },
    ticketTracker: { package: "@bluewombat/manager-fake", options: {} },
    configDir: dir,
    home: dir,
    workLineIsolation: "@bluewombat/isolation-copy",
    workspaceRoot: dir,
    ledgerRoot: dir,
    persist: "@bluewombat/persist-fs",
    builder: {
      producer: {
        cmd: ["/usr/bin/node", "/x/builder.mjs", "--api-key", "SECRET"],
        timeoutMs: 1,
        gates: [{ id: "lint", argv: ["x"], timeoutMs: 1 }],
      },
      repair: { cmd: ["agent"], timeoutMs: 1, gates: [] },
      tests: { agent: false, gates: [] },
      maxAttempts: 3,
    },
    ticket: { maxParallel: 2, gates: [] },
    feature: {
      fix: { cmd: ["agent"], timeoutMs: 1, gates: [] },
      validate: {
        agent: false,
        gates: [{ id: "e2e", argv: ["x"], timeoutMs: 1, skipWhen: "skip-test-e2e" }],
      },
      gates: [],
    },
    timeoutMs: 1000,
  } as unknown as HostInvocation;
}

describe("systemOf", () => {
  it("says what is switched on without copying a command's arguments", () => {
    const dir = mkdtempSync(join(tmpdir(), "incident-system-"));
    mkdirSync(join(dir, "node_modules/@bluewombat/slots"), { recursive: true });
    writeFileSync(join(dir, "node_modules/@bluewombat/slots/package.json"), '{"version":"1.2.3"}');
    const facts = systemOf({
      invocation: invocation(dir),
      hostVersion: "9.9.9",
      withConfig: false,
    });
    assert.equal(facts.bluewombat.host, "9.9.9");
    assert.deepEqual(facts.packages, [{ name: "@bluewombat/slots", version: "1.2.3" }]);
    assert.equal(facts.config.authority, "none");
    assert.equal(facts.config.maxParallel, 2);
    assert.equal(facts.config.reviews["builder.tests"], "off");
    assert.equal(facts.config.reviews["feature.validate"], "gates only");
    assert.deepEqual(facts.config.gates["feature.validate.gates"], [
      "e2e (skipWhen skip-test-e2e)",
    ]);
    assert.equal(facts.config.agents["builder.producer"], "node builder.mjs");
    assert.doesNotMatch(JSON.stringify(facts), /SECRET/);
    assert.equal(facts.config.raw, undefined);
  });

  it("includes the config file only when asked, with secret-looking values blanked", () => {
    const dir = mkdtempSync(join(tmpdir(), "incident-system-"));
    const path = join(dir, "mason.config.yaml");
    writeFileSync(path, "repo: a/b\ntoken: abc123\nauth:\n  apiKey: k-1\n  - secretName: s\n");
    const facts = systemOf({
      invocation: invocation(dir),
      configPath: path,
      hostVersion: "1",
      withConfig: true,
    });
    assert.match(facts.config.raw ?? "", /repo: a\/b/);
    assert.doesNotMatch(facts.config.raw ?? "", /abc123|k-1/);
    assert.match(facts.config.raw ?? "", /token: <redacted>/);
  });
});

describe("redact", () => {
  it("leaves a line that holds no secret-looking key alone", () => {
    assert.equal(redact("timeoutMs: 5\nname: x"), "timeoutMs: 5\nname: x");
  });
});
