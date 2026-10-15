import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FeatureTrackerPort, ManagerModule, TicketTrackerPort } from "@bluewombat/manager-kit";
import { contextOf, distinctManagers, openManagers, requestOf } from "./manager.js";

const features = {} as FeatureTrackerPort;
const tickets = {} as TicketTrackerPort;

function moduleOf(
  answers: { features?: boolean; tickets?: boolean },
  built: string[],
  seen: (readonly string[] | undefined)[] = [],
) {
  return {
    createManager(context) {
      built.push(String(context.options.name));
      seen.push(context.sides);
      return {
        ok: true,
        manager: {
          ...(answers.features === false ? {} : { features }),
          ...(answers.tickets === false ? {} : { tickets }),
        },
      };
    },
  } satisfies ManagerModule;
}

const common = {
  configDir: ".",
  durationMs: 1000,
  interruptFlag: { interrupted: false },
  env: {},
};

describe("distinctManagers", () => {
  it("is one manager when both sides name the same package and options", () => {
    const spec = { package: "@acme/manager", options: { board: "APP" } };
    const found = distinctManagers({ featureTracker: spec, ticketTracker: { ...spec } });
    assert.equal(found.length, 1);
    assert.deepEqual(found[0]?.sides, ["featureTracker", "ticketTracker"]);
  });

  it("is two managers when the packages differ", () => {
    const found = distinctManagers({
      featureTracker: { package: "@acme/linear", options: {} },
      ticketTracker: { package: "@acme/github", options: {} },
    });
    assert.deepEqual(
      found.map((one) => one.sides),
      [["featureTracker"], ["ticketTracker"]],
    );
  });

  it("is two managers when the options differ", () => {
    const found = distinctManagers({
      featureTracker: { package: "@acme/manager", options: { board: "A" } },
      ticketTracker: { package: "@acme/manager", options: { board: "B" } },
    });
    assert.equal(found.length, 2);
  });
});

describe("openManagers", () => {
  it("builds a manager named by both sides once", async () => {
    const built: string[] = [];
    const module = moduleOf({}, built);
    const spec = { package: module, options: { name: "one" } };
    const opened = await openManagers({ featureTracker: spec, ticketTracker: spec }, common);
    assert.equal(opened.ok, true);
    assert.deepEqual(built, ["one"]);
  });

  it("takes Features from one package and Tickets from another", async () => {
    const built: string[] = [];
    const opened = await openManagers(
      {
        featureTracker: {
          package: moduleOf({ tickets: false }, built),
          options: { name: "product" },
        },
        ticketTracker: {
          package: moduleOf({ features: false }, built),
          options: { name: "code" },
        },
      },
      common,
    );
    assert.equal(opened.ok, true);
    assert.deepEqual(built, ["product", "code"]);
  });

  it("refuses a feature tracker that answers no FeatureTracker", async () => {
    const built: string[] = [];
    const opened = await openManagers(
      {
        featureTracker: { package: moduleOf({ features: false }, built), options: {} },
        ticketTracker: { package: moduleOf({}, built), options: { name: "code" } },
      },
      common,
    );
    assert.equal(opened.ok, false);
    if (!opened.ok) {
      assert.match(opened.reason, /featureTracker/);
    }
  });
});

describe("the sides a manager is built for", () => {
  it("tells a manager named by both sides that it serves both", async () => {
    const built: string[] = [];
    const seen: (readonly string[] | undefined)[] = [];
    const spec = { package: moduleOf({}, built, seen), options: { name: "one" } };
    await openManagers({ featureTracker: spec, ticketTracker: spec }, common);
    assert.deepEqual(seen, [["featureTracker", "ticketTracker"]]);
  });

  it("tells each manager which one side it serves when the options differ", async () => {
    const built: string[] = [];
    const seen: (readonly string[] | undefined)[] = [];
    const opened = await openManagers(
      {
        featureTracker: { package: moduleOf({}, built, seen), options: { name: "f" } },
        ticketTracker: { package: moduleOf({}, built, seen), options: { name: "t" } },
      },
      common,
    );
    assert.equal(opened.ok, true);
    assert.deepEqual(seen, [["featureTracker"], ["ticketTracker"]]);
  });

  it("carries the sides into the context, and leaves them out when none were named", () => {
    const spec = { package: "@acme/manager", options: {} };
    assert.deepEqual(contextOf(requestOf(spec, common, ["ticketTracker"])).sides, [
      "ticketTracker",
    ]);
    assert.equal("sides" in contextOf(requestOf(spec, common)), false);
  });
});
