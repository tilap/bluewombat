import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { stringify as plainYaml } from "yaml";
import { fixtureYaml as stringifyYaml } from "./fixture-yaml.js";
import { loadConfig } from "./load-config.js";
import { isOn } from "./types.js";

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

describe("the file groups the config by level", () => {
  const cmd = { cmd: ["node", "x.mjs"], timeoutMs: 1000 };

  function loadFile(config: Record<string, unknown>) {
    const dir = mkdtempSync(join(tmpdir(), "host-load-"));
    const file = join(dir, "mason.config.yaml");
    writeFileSync(file, plainYaml(config));
    return loadConfig(file);
  }

  it("reads the tracker and the build under ticket, the tracker and the test under feature", () => {
    const loaded = loadConfig(
      writeRaw(`
ticket:
  tracker: { package: "@acme/tickets" }
  build:
    producer: { cmd: [node, p.mjs], timeoutMs: 1000 }
    repair: { cmd: [node, r.mjs], timeoutMs: 1000 }
feature:
  tracker: { package: "@acme/features" }
`),
    );
    assert.equal(loaded.ok, true, loaded.ok ? "" : loaded.reason);
    if (loaded.ok) {
      assert.equal(loaded.invocation.ticketTracker?.package, "@acme/tickets");
      assert.equal(loaded.invocation.featureTracker?.package, "@acme/features");
      assert.equal(loaded.invocation.builder?.producer.cmd?.[1] !== undefined, true);
      assert.equal(loaded.invocation.ticket, undefined);
      assert.equal(loaded.invocation.feature, undefined);
    }
  });

  it("refuses the old top-level keys", () => {
    for (const key of ["featureTracker", "ticketTracker", "builder"]) {
      const loaded = loadFile({ [key]: side });
      assert.equal(loaded.ok, false);
      assert.match(loaded.ok ? "" : loaded.reason, new RegExp(`unknown key "${key}"`));
    }
  });

  it("refuses feature.test without ticket.build", () => {
    const loaded = loadFile({ feature: { test: cmd } });
    assert.equal(loaded.ok, false);
    assert.match(loaded.ok ? "" : loaded.reason, /"feature.test" needs "ticket.build"/);
  });

  it("names the nested path in an error", () => {
    const loaded = loadFile({ ticket: { build: { producer: cmd } } });
    assert.equal(loaded.ok, false);
    assert.match(loaded.ok ? "" : loaded.reason, /"ticket.build" needs a "repair"/);
  });
});

function writeRaw(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "host-load-"));
  const file = join(dir, "mason.config.yaml");
  writeFileSync(file, text);
  return file;
}

describe("ticket.maxParallel", () => {
  it("reads a positive whole number", () => {
    const loaded = load({
      featureTracker: side,
      ticketTracker: side,
      ticket: { validate: { agent: false }, maxParallel: 3 },
    });
    assert.equal(loaded.ok, true);
    if (loaded.ok) {
      assert.equal(loaded.invocation.ticket?.maxParallel, 3);
    }
  });

  it("refuses zero", () => {
    const loaded = load({
      featureTracker: side,
      ticketTracker: side,
      ticket: { validate: { agent: false }, maxParallel: 0 },
    });
    assert.equal(loaded.ok, false);
  });
});

describe("feature", () => {
  const gate = { id: "check", argv: ["node", "check.mjs"], timeoutMs: 1000 };
  const fix = { cmd: ["node", "fix.mjs"], timeoutMs: 1000 };
  const validate = { cmd: ["node", "validate.mjs"], timeoutMs: 1000, gates: { gates: [gate] } };

  it("reads its gates, its fix and its budget", () => {
    const loaded = load({
      featureTracker: side,
      ticketTracker: side,
      feature: {
        validate,
        gates: { gates: [gate] },
        fix,
        maxRefusals: 2,
        maxAttempts: 4,
      },
    });
    assert.equal(loaded.ok, true);
    if (loaded.ok) {
      assert.equal(loaded.invocation.feature?.gates[0]?.id, "check");
      assert.equal(loaded.invocation.feature?.maxRefusals, 2);
    }
  });

  it("refuses a feature without gates, a validate or a fix", () => {
    for (const feature of [
      { fix, gates: { gates: [gate] } },
      { fix, validate },
      { validate, gates: { gates: [gate] } },
    ]) {
      const loaded = load({ featureTracker: side, ticketTracker: side, feature });
      assert.equal(loaded.ok, false);
    }
  });
});

describe("a review without its agent", () => {
  const gate = { id: "check", argv: ["node", "check.mjs"], timeoutMs: 1000 };
  const fix = { cmd: ["node", "fix.mjs"], timeoutMs: 1000 };

  it("keeps the gates of ticket.validate when its agent is turned off", () => {
    const loaded = load({
      featureTracker: side,
      ticketTracker: side,
      ticket: { validate: { agent: false, gates: { gates: [gate] } } },
    });
    assert.equal(loaded.ok, true, loaded.ok ? "" : loaded.reason);
    if (loaded.ok) {
      const validate = loaded.invocation.ticket?.validate;
      assert.equal(validate !== undefined && "cmd" in validate, false);
      assert.equal(validate?.gates[0]?.id, "check");
    }
  });

  it("turns the agent of feature.validate off, and allows no gates on the published line", () => {
    const loaded = load({
      featureTracker: side,
      ticketTracker: side,
      feature: {
        fix,
        validate: { agent: false, gates: { gates: [gate] } },
        gates: { gates: [] },
      },
    });
    assert.equal(loaded.ok, true, loaded.ok ? "" : loaded.reason);
  });

  it("refuses anything but gates beside agent: false", () => {
    for (const validate of [
      { agent: false, timeoutMs: 1000, gates: { gates: [gate] } },
      { agent: false, prompt: "./p.md", gates: { gates: [gate] } },
    ]) {
      for (const config of [
        { ticket: { validate } },
        { feature: { fix, validate, gates: { gates: [gate] } } },
      ]) {
        const loaded = load({ featureTracker: side, ticketTracker: side, ...config });
        assert.equal(loaded.ok, false, JSON.stringify(validate));
      }
    }
  });

  it("takes agent: false with no gates, written any way, as a review that is off", () => {
    for (const validate of [
      { agent: false },
      { agent: false, gates: null },
      { agent: false, gates: { defaultTimeoutMs: 120000, gates: null } },
      { agent: false, gates: { gates: [] } },
    ]) {
      for (const config of [
        { ticket: { validate } },
        { feature: { fix, validate, gates: { gates: [] } } },
      ]) {
        const loaded = load({ featureTracker: side, ticketTracker: side, ...config });
        assert.equal(
          loaded.ok,
          true,
          `${JSON.stringify(validate)}: ${loaded.ok ? "" : loaded.reason}`,
        );
        if (loaded.ok) {
          const read = loaded.invocation.ticket?.validate ?? loaded.invocation.feature?.validate;
          assert.equal(isOn(read), false);
        }
      }
    }
  });

  it("requires ticket.validate when a ticket block is written, and says how to turn it off", () => {
    const loaded = load({ featureTracker: side, ticketTracker: side, ticket: { maxAttempts: 2 } });
    assert.equal(loaded.ok, false);
    assert.match(loaded.ok ? "" : loaded.reason, /needs a "validate".*agent: false/);
  });
});

describe("the feature-test check", () => {
  const gate = { id: "check", argv: ["node", "check.mjs"], timeoutMs: 1000 };
  const featureTestsGate = {
    id: "feature-test",
    argv: ["node", "feature-test.mjs"],
    timeoutMs: 1000,
    skipWhen: "skip-feature-test",
  };
  const pass = { cmd: ["node", "build.mjs"], timeoutMs: 1000 };
  const builder = {
    producer: pass,
    repair: pass,
    gates: { gates: [gate] },
  };
  const featureTest = {
    cmd: ["node", "feature-test-build.mjs"],
    timeoutMs: 1000,
    gates: { gates: [gate] },
  };
  const feature = (gates: unknown[]) => ({
    fix: pass,
    gates: { gates: [gate] },
    validate: { cmd: ["node", "validate.mjs"], timeoutMs: 1000, gates: { gates } },
  });
  const config = (over: Record<string, unknown>) => ({
    featureTracker: side,
    ticketTracker: side,
    ...over,
  });

  it("is declared by feature.test and a Feature gate with skipWhen, and both are read", () => {
    const loaded = load(
      config({ builder: { ...builder, featureTest }, feature: feature([gate, featureTestsGate]) }),
    );
    assert.equal(loaded.ok, true, loaded.ok ? "" : loaded.reason);
    if (loaded.ok) {
      assert.deepEqual(
        loaded.invocation.builder?.featureTest?.gates.map((g) => g.id),
        ["check"],
      );
      const validate = loaded.invocation.feature?.validate;
      assert.equal(
        validate?.gates.find((g) => g.id === "feature-test")?.skipWhen,
        "skip-feature-test",
      );
      assert.equal(validate?.gates.find((g) => g.id === "check")?.skipWhen, undefined);
    }
  });

  it("leaves a config that does not declare it as it was", () => {
    const loaded = load(config({ builder, feature: feature([gate]) }));
    assert.equal(loaded.ok, true, loaded.ok ? "" : loaded.reason);
    if (loaded.ok) {
      assert.equal(loaded.invocation.builder?.featureTest, undefined);
    }
  });

  it("requires feature.test as soon as a Feature gate can be skipped for the feature-test check", () => {
    const loaded = load(config({ builder, feature: feature([featureTestsGate]) }));
    assert.equal(loaded.ok, false);
    assert.match(loaded.ok ? "" : loaded.reason, /"feature.test" is required/);
  });

  it("refuses feature.test when no Feature gate runs the suite", () => {
    const loaded = load(config({ builder: { ...builder, featureTest }, feature: feature([gate]) }));
    assert.equal(loaded.ok, false);
    assert.match(loaded.ok ? "" : loaded.reason, /no Feature gate runs the suite/);
  });

  it("gives feature.test its own command and gates, nothing is borrowed from the shared builder", () => {
    const loaded = load(
      config({
        builder: {
          ...builder,
          featureTest: { cmd: ["node", "feature-test-build.mjs"], timeoutMs: 1000 },
        },
        feature: feature([featureTestsGate]),
      }),
    );
    assert.equal(loaded.ok, true, loaded.ok ? "" : loaded.reason);
    if (loaded.ok) {
      assert.deepEqual(loaded.invocation.builder?.featureTest?.gates, []);
    }
    const noCommand = load(
      config({
        builder: { ...builder, featureTest: { timeoutMs: 1000 } },
        feature: feature([featureTestsGate]),
      }),
    );
    assert.equal(noCommand.ok, false);
    const noCeiling = load(
      config({
        builder: { ...builder, featureTest: { cmd: ["node", "x.mjs"] } },
        feature: feature([featureTestsGate]),
      }),
    );
    assert.equal(noCeiling.ok, false);
  });

  it("refuses a condition it does not know, and a skipWhen outside a Feature's gates", () => {
    const unknown = load(
      config({
        builder: { ...builder, featureTest },
        feature: feature([{ ...featureTestsGate, skipWhen: "skip-everything" }]),
      }),
    );
    assert.equal(unknown.ok, false);
    assert.match(unknown.ok ? "" : unknown.reason, /skip-feature-test/);

    const outside = load(
      config({
        builder: { ...builder, featureTest, gates: { gates: [featureTestsGate] } },
        feature: feature([featureTestsGate]),
      }),
    );
    assert.equal(outside.ok, false);
    assert.match(outside.ok ? "" : outside.reason, /only a Feature's gates/);
  });
});
