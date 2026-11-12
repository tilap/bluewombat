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
      maxAttempts: 3,
    },
    ticket: { maxParallel: 2, gates: [] },
    feature: {
      fix: { cmd: ["agent"], timeoutMs: 1, gates: [] },
      validate: {
        agent: false,
        gates: [{ id: "feature-test", argv: ["x"], timeoutMs: 1, skipWhen: "skip-feature-test" }],
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
    assert.equal(facts.config.reviews["feature.validate"], "gates only");
    assert.deepEqual(facts.config.gates["feature.validate.gates"], [
      "feature-test (skipWhen skip-feature-test)",
    ]);
    assert.equal(facts.config.agents["ticket.build.producer"], "node builder.mjs");
    assert.doesNotMatch(JSON.stringify(facts), /SECRET/);
    assert.equal(facts.config.raw, undefined);
  });

  it("includes the config file only when asked, with secret-looking values blanked", () => {
    const dir = mkdtempSync(join(tmpdir(), "incident-system-"));
    const path = join(dir, "mason.config.yaml");
    writeFileSync(path, "repo: a/b\ntoken: abc123\nauth:\n  apiKey: k-1\n  secretName: s\n");
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
  it("leaves a config that holds no secret as it is", () => {
    assert.equal(redact("timeoutMs: 5\nname: x\n"), "timeoutMs: 5\nname: x\n");
  });

  it("blanks by path: a secret-looking key hides its whole value, at any depth", () => {
    const out = redact(
      [
        "agents:",
        "  basic:",
        "    apiKey: k-1",
        "    credentials:",
        "      user: u",
        "      pass: p",
        "    env:",
        "      GITHUB_TOKEN: t-1",
        "    tokens: [a-1, a-2]",
        "    note: kept",
        "",
      ].join("\n"),
    );
    assert.doesNotMatch(out ?? "", /k-1|t-1|a-1|a-2|user|pass/);
    assert.match(out ?? "", /note: kept/);
  });

  it("blanks the value that follows a secret flag in a command, and the one after `=`", () => {
    const out = redact(
      [
        "gate:",
        "  argv: [node, gate.mjs, --token, s-1, --api-key=s-2, --retries, '3', --verbose]",
        "",
      ].join("\n"),
    );
    assert.doesNotMatch(out ?? "", /s-1|s-2/);
    assert.match(out ?? "", /--retries/);
    assert.match(out ?? "", /'3'|"3"|- "?3"?/);
    assert.match(out ?? "", /--verbose/);
  });

  it("blanks a secret that stands on its own, by its shape, wherever it is", () => {
    const github = `ghp_${"a".repeat(36)}`;
    const out = redact(
      [
        "list:",
        `  - ${github}`,
        "  - sk-abcdefghijklmnopqrstuvwx",
        "  - https://user:hunter2@example.com/repo.git",
        "  - plain",
        "",
      ].join("\n"),
    );
    assert.doesNotMatch(out ?? "", /ghp_|sk-abc|hunter2/);
    assert.match(out ?? "", /plain/);
    assert.match(out ?? "", /example\.com\/repo\.git/);
  });

  it("blanks a multi-line scalar, under a secret key or holding a private key", () => {
    const out = redact(
      [
        "secretFile: |",
        "  line one",
        "  line two",
        "script: |",
        "  echo hi",
        "  -----BEGIN RSA PRIVATE KEY-----",
        "  MIIEvQIBADANBgkq",
        "  -----END RSA PRIVATE KEY-----",
        "  echo bye",
        "",
      ].join("\n"),
    );
    assert.doesNotMatch(out ?? "", /line one|MIIEvQ/);
    assert.match(out ?? "", /echo hi/);
    assert.match(out ?? "", /echo bye/);
  });

  it("drops comments, which can hold a secret", () => {
    assert.doesNotMatch(redact("a: 1 # token ghp_x\n# password: p\n") ?? "", /ghp_|password/);
  });

  it("gives nothing when the text is not YAML", () => {
    assert.equal(redact("a: [unclosed\n"), undefined);
  });
});
