import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { Invocation, Plan } from "../types.js";
import { runBreakdown } from "./run-breakdown.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures");
const node = process.execPath;

const FEATURE = {
  key: "fake:42",
  intention: "Export CSV",
  extra: "never-on-plan",
};

function featureJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...FEATURE, ...over });
}

function sandbox(): string {
  return mkdtempSync(join(tmpdir(), "feature-breakdown-"));
}

function baseInvocation(over: Partial<Invocation> = {}): Invocation {
  return {
    maxFeatureBytes: 65_536,
    maxUnits: 20,
    plannerArgv: [node, join(fixtures, "planner-ok.mjs")],
    plannerDurationMs: 10_000,
    plannedAt: "2026-09-05T10:00:00.000Z",
    ...over,
  };
}

function collectLines(): {
  write: (line: Record<string, unknown>) => void;
  lines: Record<string, unknown>[];
} {
  const lines: Record<string, unknown>[] = [];
  return {
    lines,
    write: (line) => {
      lines.push(line);
    },
  };
}

function resultLine(lines: Record<string, unknown>[]): Record<string, unknown> | undefined {
  return lines.filter((l) => l.event === "result").at(-1);
}

describe("runBreakdown acceptance", { concurrency: false }, () => {
  it("1. usable FeatureStandard and one Subtask → planned, exit 0, plan.key matches", async () => {
    const { write, lines } = collectLines();
    const result = await runBreakdown({
      invocation: baseInvocation(),
      featureJson: featureJson(),
      write,
    });
    assert.equal(result.outcome, "planned");
    assert.equal(result.exitCode, 0);
    assert.equal(result.plan?.key, "fake:42");
    const last = resultLine(lines);
    assert.equal(last?.outcome, "planned");
    const plan = last?.plan as Plan;
    assert.equal(plan.key, "fake:42");
    assert.equal(plan.subtasks[0]?.id, "st-1");
  });

  it("2. same FeatureStandard, same Plan, same --at → same fingerprint", async () => {
    const first = await runBreakdown({
      invocation: baseInvocation(),
      featureJson: featureJson(),
      write: () => {},
    });
    const second = await runBreakdown({
      invocation: baseInvocation(),
      featureJson: featureJson(),
      write: () => {},
    });
    assert.equal(first.plan?.fingerprint, second.plan?.fingerprint);
  });

  it("3. intention change changes fingerprint; --at does not; list order does not", async () => {
    const baseline = await runBreakdown({
      invocation: baseInvocation({
        plannerArgv: [node, join(fixtures, "planner-intention.mjs")],
      }),
      featureJson: featureJson(),
      write: () => {},
    });
    process.env.PLANNER_INTENTION = "Add the CSV serializer!";
    try {
      const changed = await runBreakdown({
        invocation: baseInvocation({
          plannerArgv: [node, join(fixtures, "planner-intention.mjs")],
        }),
        featureJson: featureJson(),
        write: () => {},
      });
      assert.notEqual(baseline.plan?.fingerprint, changed.plan?.fingerprint);
    } finally {
      delete process.env.PLANNER_INTENTION;
    }

    const otherAt = await runBreakdown({
      invocation: baseInvocation({ plannedAt: "2026-09-06T00:00:00.000Z" }),
      featureJson: featureJson(),
      write: () => {},
    });
    assert.equal(baseline.plan?.fingerprint, otherAt.plan?.fingerprint);
    assert.notEqual(baseline.plan?.planned_at, otherAt.plan?.planned_at);

    const orderA = await runBreakdown({
      invocation: baseInvocation({
        plannerArgv: [node, join(fixtures, "planner-order.mjs")],
      }),
      featureJson: featureJson(),
      write: () => {},
    });
    process.env.PLANNER_SWAP_ORDER = "1";
    try {
      const orderB = await runBreakdown({
        invocation: baseInvocation({
          plannerArgv: [node, join(fixtures, "planner-order.mjs")],
        }),
        featureJson: featureJson(),
        write: () => {},
      });
      assert.equal(orderA.plan?.fingerprint, orderB.plan?.fingerprint);
      assert.deepEqual(
        orderA.plan?.subtasks.map((s) => s.id),
        ["st-1", "st-2"],
      );
      assert.deepEqual(
        orderB.plan?.subtasks.map((s) => s.id),
        ["st-2", "st-1"],
      );
    } finally {
      delete process.env.PLANNER_SWAP_ORDER;
    }
  });

  it("4. Planner refusal → refused not-specifiable, exit 1, no plan", async () => {
    const { write, lines } = collectLines();
    const result = await runBreakdown({
      invocation: baseInvocation({
        plannerArgv: [node, join(fixtures, "planner-refused.mjs")],
      }),
      featureJson: featureJson(),
      write,
    });
    assert.equal(result.outcome, "refused");
    assert.equal(result.exitCode, 1);
    assert.equal(result.code, "not-specifiable");
    assert.equal(result.plan, undefined);
    assert.equal(resultLine(lines)?.plan, undefined);
  });

  it("5. mutual depends_on → refused cycle, exit 1", async () => {
    const result = await runBreakdown({
      invocation: baseInvocation({
        plannerArgv: [node, join(fixtures, "planner-cycle.mjs")],
      }),
      featureJson: featureJson(),
      write: () => {},
    });
    assert.equal(result.outcome, "refused");
    assert.equal(result.exitCode, 1);
    assert.equal(result.code, "cycle");
  });

  it("6. three Subtasks with --max-units 2 → plan-too-large, Plan not emitted", async () => {
    const { write, lines } = collectLines();
    const result = await runBreakdown({
      invocation: baseInvocation({
        plannerArgv: [node, join(fixtures, "planner-three.mjs")],
        maxUnits: 2,
      }),
      featureJson: featureJson(),
      write,
    });
    assert.equal(result.outcome, "refused");
    assert.equal(result.code, "plan-too-large");
    assert.equal(resultLine(lines)?.plan, undefined);
  });

  it("7. empty subtasks → empty-plan", async () => {
    const result = await runBreakdown({
      invocation: baseInvocation({
        plannerArgv: [node, join(fixtures, "planner-empty.mjs")],
      }),
      featureJson: featureJson(),
      write: () => {},
    });
    assert.equal(result.outcome, "refused");
    assert.equal(result.code, "empty-plan");
  });

  it("8. unknown depends_on id → unknown-dependency", async () => {
    const result = await runBreakdown({
      invocation: baseInvocation({
        plannerArgv: [node, join(fixtures, "planner-unknown-dep.mjs")],
      }),
      featureJson: featureJson(),
      write: () => {},
    });
    assert.equal(result.outcome, "refused");
    assert.equal(result.code, "unknown-dependency");
  });

  it("9. missing definition_of_done → missing-definition-of-done", async () => {
    const result = await runBreakdown({
      invocation: baseInvocation({
        plannerArgv: [node, join(fixtures, "planner-missing-dod.mjs")],
      }),
      featureJson: featureJson(),
      write: () => {},
    });
    assert.equal(result.outcome, "refused");
    assert.equal(result.code, "missing-definition-of-done");
  });

  it("10. no intention → missing-intention, Planner not spawned", async () => {
    const dir = sandbox();
    const marker = join(dir, "spawned.log");
    process.env.PLANNER_SPAWNED_LOG = marker;
    try {
      const { write, lines } = collectLines();
      const result = await runBreakdown({
        invocation: baseInvocation(),
        featureJson: featureJson({ intention: "" }),
        write,
      });
      assert.equal(result.outcome, "refused");
      assert.equal(result.code, "missing-intention");
      assert.equal(existsSync(marker), false);
      assert.equal(
        lines.some((l) => l.event === "planner-finished"),
        false,
      );
    } finally {
      delete process.env.PLANNER_SPAWNED_LOG;
    }
  });

  it("11. Planner non-zero without refusal object → unavailable, not refused", async () => {
    const result = await runBreakdown({
      invocation: baseInvocation({
        plannerArgv: [node, join(fixtures, "planner-fail.mjs")],
      }),
      featureJson: featureJson(),
      write: () => {},
    });
    assert.equal(result.outcome, "unavailable");
    assert.equal(result.exitCode, 3);
    assert.notEqual(result.outcome, "refused");
  });

  it("12. one byte over max-feature-bytes → feature-too-large, Planner not spawned", async () => {
    const dir = sandbox();
    const marker = join(dir, "spawned.log");
    process.env.PLANNER_SPAWNED_LOG = marker;
    try {
      const raw = featureJson();
      const result = await runBreakdown({
        invocation: baseInvocation({
          maxFeatureBytes: Buffer.byteLength(raw, "utf8") - 1,
        }),
        featureJson: raw,
        write: () => {},
      });
      assert.equal(result.outcome, "refused");
      assert.equal(result.code, "feature-too-large");
      assert.equal(existsSync(marker), false);
    } finally {
      delete process.env.PLANNER_SPAWNED_LOG;
    }
  });

  it("13. interrupt while Planner runs → interrupted, no plan on result", async () => {
    const { write, lines } = collectLines();
    const flag = { interrupted: false };
    const pending = runBreakdown({
      invocation: baseInvocation({
        plannerArgv: [node, join(fixtures, "planner-sleep.mjs"), "30000"],
        plannerDurationMs: 60_000,
      }),
      featureJson: featureJson(),
      write,
      interruptFlag: flag,
    });
    await new Promise((r) => setTimeout(r, 80));
    flag.interrupted = true;
    const result = await pending;
    assert.equal(result.outcome, "interrupted");
    assert.equal(result.exitCode, 130);
    assert.equal(resultLine(lines)?.plan, undefined);
  });

  it("14. entering Planner announces planning:fake:42 on stdout and --on-status", async () => {
    const dir = sandbox();
    const statusLog = join(dir, "status.log");
    process.env.ON_STATUS_LOG = statusLog;
    try {
      const { write, lines } = collectLines();
      const result = await runBreakdown({
        invocation: baseInvocation({
          onStatusArgv: [node, join(fixtures, "on-status-log.mjs")],
        }),
        featureJson: featureJson(),
        write,
      });
      assert.equal(result.outcome, "planned");
      assert.ok(lines.some((l) => l.event === "status" && l.label === "planning:fake:42"));
      const logged = readFileSync(statusLog, "utf8");
      assert.ok(logged.includes("planning:fake:42"));
    } finally {
      delete process.env.ON_STATUS_LOG;
    }
  });

  it("15. --on-status exiting non-zero does not change a planned run", async () => {
    const result = await runBreakdown({
      invocation: baseInvocation({
        onStatusArgv: [node, join(fixtures, "on-status-fail.mjs")],
      }),
      featureJson: featureJson(),
      write: () => {},
    });
    assert.equal(result.outcome, "planned");
  });

  it("16. creates no file in cwd", async () => {
    const dir = sandbox();
    writeFileSync(join(dir, "keep.txt"), "ok");
    const previous = process.cwd();
    process.chdir(dir);
    try {
      const result = await runBreakdown({
        invocation: baseInvocation(),
        featureJson: featureJson(),
        write: () => {},
      });
      assert.equal(result.outcome, "planned");
      assert.deepEqual(readdirSync(dir).sort(), ["keep.txt"]);
    } finally {
      process.chdir(previous);
    }
  });

  it("17. unknown FeatureStandard and Subtask fields never appear on the Plan", async () => {
    const result = await runBreakdown({
      invocation: baseInvocation(),
      featureJson: featureJson(),
      write: () => {},
    });
    assert.equal(result.outcome, "planned");
    const plan = result.plan as Plan;
    assert.equal("extra" in plan, false);
    assert.equal("extra_plan" in plan, false);
    assert.equal("extra" in (plan.subtasks[0] ?? {}), false);
    const keys = Object.keys(plan).sort();
    assert.deepEqual(keys, ["fingerprint", "key", "planned_at", "subtasks"]);
  });

  it("Planner argv includes key, intention, max-units, and title when present", async () => {
    const dir = sandbox();
    const argsLog = join(dir, "args.json");
    process.env.PLANNER_ARGS_LOG = argsLog;
    try {
      const result = await runBreakdown({
        invocation: baseInvocation(),
        featureJson: featureJson({ title: "Export" }),
        write: () => {},
      });
      assert.equal(result.outcome, "planned");
      const argv = JSON.parse(readFileSync(argsLog, "utf8")) as string[];
      assert.deepEqual(argv.slice(-8), [
        "--key",
        "fake:42",
        "--intention",
        "Export CSV",
        "--max-units",
        "20",
        "--title",
        "Export",
      ]);
    } finally {
      delete process.env.PLANNER_ARGS_LOG;
    }
  });

  it("omits --title when the FeatureStandard has none", async () => {
    const dir = sandbox();
    const argsLog = join(dir, "args.json");
    process.env.PLANNER_ARGS_LOG = argsLog;
    try {
      await runBreakdown({
        invocation: baseInvocation(),
        featureJson: featureJson(),
        write: () => {},
      });
      const argv = JSON.parse(readFileSync(argsLog, "utf8")) as string[];
      assert.equal(argv.includes("--title"), false);
    } finally {
      delete process.env.PLANNER_ARGS_LOG;
    }
  });

  it("Planner unparseable stdout → unavailable", async () => {
    const result = await runBreakdown({
      invocation: baseInvocation({
        plannerArgv: [node, join(fixtures, "planner-not-json.mjs")],
      }),
      featureJson: featureJson(),
      write: () => {},
    });
    assert.equal(result.outcome, "unavailable");
  });

  it("Planner clock → unavailable and names the clock", async () => {
    const result = await runBreakdown({
      invocation: baseInvocation({
        plannerArgv: [node, join(fixtures, "planner-sleep.mjs"), "5000"],
        plannerDurationMs: 50,
      }),
      featureJson: featureJson(),
      write: () => {},
    });
    assert.equal(result.outcome, "unavailable");
    assert.match(result.detail ?? "", /clock/i);
  });
});
