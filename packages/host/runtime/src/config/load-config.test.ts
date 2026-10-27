import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { stringify as stringifyYaml } from "yaml";
import { loadConfig } from "./load-config.js";
import { hasAgent, isOn } from "./types.js";

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

describe("builder.tests", () => {
  const gate = { id: "red", argv: ["node", "tests-red.mjs"], timeoutMs: 1000 };
  const producer = { cmd: ["node", "p.mjs"], timeoutMs: 1000 };
  const builder = (tests: unknown) => ({ tests, producer, repair: producer });

  it("reads an agent with its gates, written like any pass", () => {
    const loaded = load({
      featureTracker: side,
      ticketTracker: side,
      builder: builder({ cmd: ["node", "tests.mjs"], timeoutMs: 1000, gates: { gates: [gate] } }),
    });
    assert.equal(loaded.ok, true, loaded.ok ? "" : loaded.reason);
    if (loaded.ok) {
      const tests = loaded.invocation.builder?.tests;
      assert.equal(tests !== undefined && hasAgent(tests) ? tests.gates[0]?.id : undefined, "red");
    }
  });

  it("is required, and says how to write none", () => {
    const loaded = load({
      featureTracker: side,
      ticketTracker: side,
      builder: { producer, repair: producer },
    });
    assert.equal(loaded.ok, false);
    assert.match(loaded.ok ? "" : loaded.reason, /needs "tests".*agent: false/);
  });

  it("writes none with agent: false, however the empty gates are written", () => {
    for (const tests of [
      { agent: false },
      { agent: false, gates: null },
      { agent: false, gates: [] },
      { agent: false, gates: { gates: [] } },
    ]) {
      const loaded = load({ featureTracker: side, ticketTracker: side, builder: builder(tests) });
      assert.equal(loaded.ok, true, `${JSON.stringify(tests)}: ${loaded.ok ? "" : loaded.reason}`);
      if (loaded.ok) {
        assert.equal(isOn(loaded.invocation.builder?.tests), false);
      }
    }
  });

  it("refuses gates, or anything else, beside agent: false", () => {
    for (const tests of [
      { agent: false, gates: { gates: [gate] } },
      { agent: false, timeoutMs: 1000 },
      { agent: false, prompt: "./p.md" },
    ]) {
      const loaded = load({ featureTracker: side, ticketTracker: side, builder: builder(tests) });
      assert.equal(loaded.ok, false, JSON.stringify(tests));
    }
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
    tests: { agent: false },
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

  it("is declared by builder.featureTest and a Feature gate with skipWhen, and both are read", () => {
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

  it("requires builder.featureTest as soon as a Feature gate can be skipped for the feature-test check", () => {
    const loaded = load(config({ builder, feature: feature([featureTestsGate]) }));
    assert.equal(loaded.ok, false);
    assert.match(loaded.ok ? "" : loaded.reason, /"builder.featureTest" is required/);
  });

  it("refuses builder.featureTest when no Feature gate runs the suite", () => {
    const loaded = load(config({ builder: { ...builder, featureTest }, feature: feature([gate]) }));
    assert.equal(loaded.ok, false);
    assert.match(loaded.ok ? "" : loaded.reason, /no Feature gate runs the suite/);
  });

  it("gives builder.featureTest its own command and gates, nothing is borrowed from the shared builder", () => {
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
