import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { GateSpec } from "@bluewombat/implementer";
import type {
  Delivery,
  FoldResult,
  ManagerModule,
  ManagerPort,
  ProbeResult,
  ReportInput,
  SubmissionRequest,
  SubmissionResult,
} from "@bluewombat/manager-kit";
import type { HostOptions } from "../config/types.js";
import { cursorPath } from "./cursor.js";
import type { Journal } from "./journal.js";
import { openHost } from "./open-host.js";

/**
 * Host with an Authority, end to end, without a tracker and without a remote.
 *
 * The manager is an in-memory module handed straight to `openHost`, so what it
 * was asked to submit, fold and report is read back as data. The Publisher and
 * the Refresher are the slots they are: one-line scripts answering the
 * contract, written per test.
 */

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures");
const node = process.execPath;
const TARGET = "dev";
const KEY = "stub:42";
const REFERENCE = "pr-1";

type Paths = {
  root: string;
  workLineStable: string;
  workspaceRoot: string;
  ledgerRoot: string;
};

function sandbox(): Paths {
  const root = mkdtempSync(join(tmpdir(), "host-authority-"));
  const workLineStable = join(root, "stable");
  mkdirSync(workLineStable);
  writeFileSync(join(workLineStable, "seed.txt"), "already good\n");
  return {
    root,
    workLineStable,
    workspaceRoot: join(root, "workspaces"),
    ledgerRoot: join(root, "ledger"),
  };
}

/** A slot that answers one JSON line, whatever it is asked. */
function slot(root: string, name: string, answer: Record<string, unknown>): string[] {
  const path = join(root, `${name}.mjs`);
  writeFileSync(path, `console.log(${JSON.stringify(JSON.stringify(answer))});\n`);
  return [node, path];
}

function convertible(id = "42"): Record<string, unknown> {
  return {
    id,
    project: "proj",
    intention: "deliver the marker file",
  };
}

type Stub = {
  module: ManagerModule;
  deliveries: Delivery[];
  listens: number;
  reports: ReportInput[];
  submissions: SubmissionRequest[];
  folds: string[];
  submitAnswer: SubmissionResult;
  foldAnswer: FoldResult;
  listenOutcome: string;
  probes: string[];
  probe?: (key: string) => Promise<ProbeResult>;
  /** Without Submission methods, so the manager cannot be an Authority. */
  foldsLocally: boolean;
  onListen?: () => void;
};

function stubManager(over: Partial<Stub> = {}): Stub {
  const seenEventIds = new Set<string>();
  const stub: Stub = {
    deliveries: [],
    listens: 0,
    reports: [],
    submissions: [],
    folds: [],
    submitAnswer: { outcome: "submitted", reference: REFERENCE },
    foldAnswer: { outcome: "folded", reference: "9aeff61" },
    listenOutcome: "listened",
    probes: [],
    foldsLocally: false,
    ...over,
    module: {
      createManager() {
        const port: ManagerPort = {
          async listen() {
            stub.listens += 1;
            stub.onListen?.();
            return { outcome: stub.listenOutcome, deliveries: stub.deliveries.splice(0) };
          },
          async adapt(payload) {
            if (payload.unavailable === true) {
              return { outcome: "unavailable" };
            }
            const id = String(payload.id);
            return {
              outcome: "converted",
              feature: {
                key: `stub:${id}`,
                manager: "stub",
                external_id: id,
                intent: "upsert",
                project: String(payload.project),
                intention: String(payload.intention),
                priority: 50,
                fingerprint: `fp-${id}`,
                normalized_at: "2026-09-06T10:00:00Z",
              },
            };
          },
          async report(input) {
            // What a manager that keeps a thread does: an id already written
            // is not written again.
            if (input.eventId !== undefined) {
              if (seenEventIds.has(input.eventId)) {
                return false;
              }
              seenEventIds.add(input.eventId);
            }
            stub.reports.push(input);
            return true;
          },
        };
        if (stub.probe !== undefined) {
          const probe = stub.probe;
          port.probe = async (key) => {
            stub.probes.push(key);
            return await probe(key);
          };
        }
        if (!stub.foldsLocally) {
          port.submit = async (input) => {
            stub.submissions.push(input);
            return stub.submitAnswer;
          };
          port.fold = async (input) => {
            stub.folds.push(input.reference);
            return stub.foldAnswer;
          };
        }
        return { ok: true, manager: port };
      },
    },
  };
  return stub;
}

function memoryJournal(): Journal & { lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  return {
    lines,
    append(line) {
      lines.push(line);
    },
  };
}

function blockingGates(): GateSpec[] {
  return [
    { id: "check", argv: [node, join(fixtures, "gate-fail-blocking.mjs")], timeoutMs: 10_000 },
  ];
}

function blockingBuilder(): HostOptions["builder"] {
  return {
    producer: {
      cmd: [node, join(fixtures, "builder-write-marker.mjs")],
      timeoutMs: 30_000,
      gates: blockingGates(),
    },
    repair: {
      cmd: [node, join(fixtures, "builder-write-marker.mjs")],
      timeoutMs: 30_000,
      gates: [],
    },
  };
}

function passingGates(): GateSpec[] {
  return [{ id: "check", argv: [node, join(fixtures, "gate-pass.mjs")], timeoutMs: 10_000 }];
}

function optionsFor(paths: Paths, stub: Stub, over: Partial<HostOptions> = {}): HostOptions {
  return {
    manager: stub.module,
    workLineStable: paths.workLineStable,
    workLineBranch: TARGET,
    workLineIsolation: "@bluewombat/isolation-copy",
    workspaceRoot: paths.workspaceRoot,
    ledgerRoot: paths.ledgerRoot,
    planner: {
      cmd: [node, join(fixtures, "planner-one-subtask.mjs")],
      timeoutMs: 30_000,
      gates: [],
    },
    builder: {
      producer: {
        cmd: [node, join(fixtures, "builder-write-marker.mjs")],
        timeoutMs: 30_000,
        gates: passingGates(),
      },
      repair: {
        cmd: [node, join(fixtures, "builder-write-marker.mjs")],
        timeoutMs: 30_000,
        gates: [],
      },
    },
    assembly: { gates: [] },
    authority: {
      enabled: true,
      publishArgv: slot(paths.root, "publisher", { ref: "shelf/42" }),
      refreshArgv: slot(paths.root, "refresher", { ok: true }),
    },
    timeoutMs: 30_000,
    write: () => {},
    ...over,
  };
}

describe("host with an Authority", () => {
  it("offers the assembled feature, then folds it on a later pass nobody asked for", async () => {
    const paths = sandbox();
    const stub = stubManager({ deliveries: [{ cursor: "1", payload: convertible() }] });
    const journal = memoryJournal();
    const host = await openHost(optionsFor(paths, stub), { journal });

    const first = await host.runOnce();

    assert.equal(first.lastRun?.outcome, "paused");
    assert.deepEqual(first.reported, ["accepted", "planned", "progress", "submitted"]);
    const submitted = await host.ledger.get(KEY);
    assert.equal(submitted.ok && submitted.aggregate.state, "submitted");
    assert.equal(submitted.ok && submitted.aggregate.submission?.reference, REFERENCE);
    // What the manager is told to look at is the Publisher's name for the
    // work, on the work line the config chose.
    assert.equal(stub.submissions.length, 1);
    assert.equal(stub.submissions[0]?.ref, "shelf/42");
    assert.equal(stub.submissions[0]?.target, TARGET);
    assert.equal(stub.submissions[0]?.intention, "deliver the marker file");
    // The work line is the Authority's to change, not Host's.
    assert.equal(existsSync(join(paths.workLineStable, "delivered.txt")), false);
    assert.ok(
      journal.lines.some((line) => line.event === "submitted" && line.reference === REFERENCE),
    );

    // Nothing new from the tracker: the sweep alone drives the feature on.
    const second = await host.runOnce();

    assert.equal(second.lastRun?.outcome, "done");
    assert.deepEqual(second.reported, ["done"], "the Plan was said once");
    assert.deepEqual(stub.folds, [REFERENCE]);
    const done = await host.ledger.get(KEY);
    assert.equal(done.ok && done.aggregate.state, "done");
    // Whoever reads the tracker cannot open a directory on this machine.
    assert.equal(stub.reports.at(-1)?.fields.reference, REFERENCE);
    // The commit the Authority made travels Conductor → ledger → report.
    assert.equal(stub.reports.at(-1)?.fields.integration_reference, "9aeff61");
    assert.ok(journal.lines.some((line) => line.event === "sweep"));
    assert.deepEqual(
      journal.lines.filter((line) => line.event === "refresh").map((line) => line.outcome),
      ["ok", "ok"],
    );
  });

  it("reports done on the Feature that was driven, not on a Feature only just admitted", async () => {
    const paths = sandbox();
    const stub = stubManager({ deliveries: [{ cursor: "1", payload: convertible() }] });
    const journal = memoryJournal();
    const host = await openHost(optionsFor(paths, stub), { journal });

    const first = await host.runOnce();
    assert.equal(first.lastRun?.outcome, "paused");
    const submitted = await host.ledger.get(KEY);
    assert.equal(submitted.ok && submitted.aggregate.state, "submitted");

    stub.deliveries.push({ cursor: "2", payload: convertible("43") });
    const second = await host.runOnce();
    assert.ok(second.reported.includes("accepted"));
    assert.ok(second.reported.includes("done"));
    const behind = await host.ledger.get("stub:43");
    assert.equal(behind.ok && behind.aggregate.state, "received");
    const folded = await host.ledger.get(KEY);
    assert.equal(folded.ok && folded.aggregate.state, "done");
    assert.deepEqual(
      stub.reports.filter((report) => report.key === "stub:43").map((report) => report.event),
      ["accepted"],
    );
    assert.ok(stub.reports.some((report) => report.key === KEY && report.event === "done"));

    const third = await host.runOnce();
    assert.ok(third.reported.includes("submitted"));
    const started = await host.ledger.get("stub:43");
    assert.equal(started.ok && started.aggregate.state, "submitted");
    assert.deepEqual(
      journal.lines.filter((line) => line.event === "refresh").map((line) => line.outcome),
      ["ok", "ok", "ok"],
    );
  });

  it("hands the Publisher the name the isolation strategy gave the Child", async () => {
    const paths = sandbox();
    const stub = stubManager({ deliveries: [{ cursor: "1", payload: convertible() }] });
    // A strategy that names its Children its own way. Host must not assume git.
    const naming = join(paths.root, "naming-strategy.mjs");
    const copyStrategy = import.meta.resolve("@bluewombat/isolation-copy");
    writeFileSync(
      naming,
      [
        `import { strategy as copy } from ${JSON.stringify(copyStrategy)};`,
        'export const strategy = { ...copy, refOf: (id) => "shelf/" + id.replaceAll(":", "-") };',
        "",
      ].join("\n"),
    );
    const argvFile = join(paths.root, "publisher-argv.json");
    const publisher = join(paths.root, "publisher-recording.mjs");
    writeFileSync(
      publisher,
      [
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));`,
        'console.log(JSON.stringify({ ref: "published/42" }));',
        "",
      ].join("\n"),
    );
    const host = await openHost(
      optionsFor(paths, stub, {
        workLineIsolation: naming,
        authority: {
          enabled: true,
          publishArgv: [node, publisher],
          refreshArgv: slot(paths.root, "refresher", { ok: true }),
        },
      }),
    );

    await host.runOnce();

    const argv: string[] = JSON.parse(readFileSync(argvFile, "utf8"));
    assert.equal(argv[argv.indexOf("--ref") + 1], `shelf/${KEY.replaceAll(":", "-")}`);
    assert.equal(stub.submissions[0]?.ref, "published/42");
  });

  it("says on the tracker that the Submission was refused and a repair is on its way", async () => {
    const paths = sandbox();
    const stub = stubManager({ deliveries: [{ cursor: "1", payload: convertible() }] });
    const host = await openHost(
      optionsFor(paths, stub, {
        maxRefusals: 3,
        assembly: {
          fix: {
            cmd: [node, join(fixtures, "builder-write-marker.mjs")],
            timeoutMs: 30_000,
            gates: [],
          },
          gates: [
            // The Authority's judge: refuses the first round, takes the next.
            {
              id: "ci",
              argv: [node, join(fixtures, "gate-refuse-first-round.mjs")],
              timeoutMs: 10_000,
            },
          ],
        },
      }),
    );

    const offered = await host.runOnce();
    assert.deepEqual(offered.reported, ["accepted", "planned", "progress", "submitted"]);

    // The judge refuses: the tracker hears it, then Host re-drives the repair
    // and re-offer in the same tick (no poll wait for a local refusal).
    const refused = await host.runOnce();
    assert.equal(refused.lastRun?.outcome, "paused");
    assert.ok(refused.reported.includes("progress"));
    const progress = stub.reports.find(
      (r) =>
        r.event === "progress" &&
        typeof r.fields.summary === "string" &&
        /refused the Submission; a repair is on its way \(refusal 1 of 3\)/.test(r.fields.summary),
    );
    assert.ok(progress !== undefined);
    assert.equal(progress?.fields.stage, "submitting");
    assert.equal(progress?.fields.trace, "lint failed");
    assert.equal(stub.submissions.length, 2);
    const back = await host.ledger.get(KEY);
    assert.equal(back.ok && back.aggregate.state, "submitted");

    // Taken.
    const done = await host.runOnce();
    assert.deepEqual(done.reported, ["done"]);
    assert.deepEqual(stub.folds, [REFERENCE]);
  });

  it("an echo of Submitted while the Feature is submitted does not freeze as a plan refusal", async () => {
    const paths = sandbox();
    const stub = stubManager({ deliveries: [{ cursor: "1", payload: convertible() }] });
    const journal = memoryJournal();
    const host = await openHost(
      optionsFor(paths, stub, {
        maxRefusals: 3,
        assembly: {
          fix: {
            cmd: [node, join(fixtures, "builder-write-marker.mjs")],
            timeoutMs: 30_000,
            gates: [],
          },
          gates: [
            {
              id: "ci",
              argv: [node, join(fixtures, "gate-refuse-first-round.mjs")],
              timeoutMs: 10_000,
            },
          ],
        },
      }),
      { journal },
    );

    const offered = await host.runOnce();
    assert.deepEqual(offered.reported, ["accepted", "planned", "progress", "submitted"]);
    const submitted = await host.ledger.get(KEY);
    assert.equal(submitted.ok && submitted.aggregate.state, "submitted");

    // The tracker echoing ## Submitted: same body, delivered again. The judge
    // refuses, then Host repairs and re-offers in the same tick.
    stub.deliveries.push({ cursor: "2", payload: convertible() });
    const refused = await host.runOnce();
    assert.equal(refused.lastRun?.outcome, "paused");
    assert.ok(refused.reported.includes("progress"));
    assert.ok(journal.lines.some((line) => line.event === "skipped" && line.state === "submitted"));
    const offeredAgain = await host.ledger.get(KEY);
    assert.equal(offeredAgain.ok && offeredAgain.aggregate.state, "submitted");
    assert.equal(offeredAgain.ok && offeredAgain.aggregate.pending_fingerprint, undefined);
    assert.equal(offeredAgain.ok && offeredAgain.aggregate.escalation, undefined);
    assert.equal(stub.submissions.length, 2);
  });

  it("escalates at the submitting stage when the Authority refuses the offer", async () => {
    const paths = sandbox();
    const stub = stubManager({
      deliveries: [{ cursor: "1", payload: convertible() }],
      submitAnswer: { outcome: "refused", reason: "not now" },
    });
    const host = await openHost(optionsFor(paths, stub));

    const tick = await host.runOnce();

    assert.equal(tick.lastRun?.outcome, "escalated");
    assert.deepEqual(tick.reported, ["accepted", "planned", "progress", "escalated"]);
    assert.equal(stub.reports.at(-1)?.fields.stage, "submitting");
    const got = await host.ledger.get(KEY);
    assert.equal(got.ok && got.aggregate.state, "escalated");
    assert.equal(got.ok && got.aggregate.escalation?.kind, "submitted");
    assert.equal(stub.folds.length, 0);
  });

  it("does not refresh the work line on a pass with nothing to drive", async () => {
    const paths = sandbox();
    const stub = stubManager({ deliveries: [] });
    const journal = memoryJournal();
    const host = await openHost(
      optionsFor(paths, stub, {
        authority: {
          enabled: true,
          publishArgv: slot(paths.root, "publisher", { ref: "shelf/42" }),
          refreshArgv: slot(paths.root, "refresher", { ok: true }),
        },
      }),
      { journal },
    );

    const tick = await host.runOnce();
    // A pass that found nothing is held, not written; closing flushes it with
    // the count of passes it stands for.
    await host.close();

    assert.equal(tick.reported.length, 0);
    assert.equal(
      journal.lines.some((line) => line.event === "refresh"),
      false,
    );
    const idle = journal.lines.find((line) => line.event === "idle");
    assert.equal(idle?.passes, 1);
  });

  it("starts nothing when the work line cannot be brought up to date", async () => {
    const paths = sandbox();
    const stub = stubManager({ deliveries: [{ cursor: "1", payload: convertible() }] });
    const journal = memoryJournal();
    const options = optionsFor(paths, stub);
    const host = await openHost(
      {
        ...options,
        authority: {
          enabled: true,
          publishArgv: slot(paths.root, "publisher", { ref: "shelf/42" }),
          refreshArgv: slot(paths.root, "behind", { ok: false, reason: "diverged" }),
        },
      },
      { journal },
    );

    const tick = await host.runOnce();

    assert.deepEqual(tick, { listenerOutcome: "skipped", reported: [] });
    // The tracker is asked — that is how the pass knows there is work — but
    // nothing is admitted or driven, and the Cursor does not move.
    assert.equal(stub.listens, 1);
    assert.equal(stub.reports.length, 0);
    assert.equal(existsSync(cursorPath(paths.ledgerRoot)), false);
    const refresh = journal.lines.find((line) => line.event === "refresh");
    assert.equal(refresh?.outcome, "failed");
    assert.equal(refresh?.detail, "diverged");
    assert.equal(refresh?.target, TARGET);
  });
});

describe("what openHost refuses to compose", () => {
  it("an Authority with no work line to offer the work to", async () => {
    const paths = sandbox();
    const options = optionsFor(paths, stubManager());
    delete options.workLineBranch;
    await assert.rejects(openHost(options), /workLine\.branch/);
  });

  it("an Authority on a manager that declares no Submission", async () => {
    const paths = sandbox();
    await assert.rejects(
      openHost(optionsFor(paths, stubManager({ foldsLocally: true }))),
      /cannot be an Authority/,
    );
  });

  it("a work line checked out on another branch than the config names", async () => {
    const paths = sandbox();
    execFileSync("git", ["init", "-q", "-b", "main", paths.workLineStable]);
    await assert.rejects(
      openHost(optionsFor(paths, stubManager(), { workLineBranch: "dev" })),
      /is on "main", but the config wants "dev"/,
    );
    // The same tree on the named branch composes.
    const host = await openHost(optionsFor(paths, stubManager(), { workLineBranch: "main" }));
    assert.ok(host.conductor !== undefined);
  });

  it("a manager that will not open, in its own words", async () => {
    const paths = sandbox();
    const refusing: ManagerModule = {
      createManager() {
        return { ok: false, reason: "token is not set" };
      },
    };
    await assert.rejects(
      openHost(optionsFor(paths, stubManager(), { manager: refusing })),
      /token is not set/,
    );
  });

  it("an isolation strategy it cannot load", async () => {
    const paths = sandbox();
    await assert.rejects(
      openHost(optionsFor(paths, stubManager(), { workLineIsolation: "./no-such-strategy.js" })),
      /no-such-strategy\.js/,
    );
  });
});

describe("one Host pass", () => {
  it("holds the Cursor on a delivery the manager cannot adapt right now", async () => {
    const paths = sandbox();
    const stub = stubManager({
      deliveries: [
        { cursor: "1", payload: { unavailable: true } },
        { cursor: "2", payload: convertible() },
      ],
    });
    const host = await openHost(optionsFor(paths, stub));

    const tick = await host.runOnce();

    // Nothing was handled, so nothing is behind us: the next pass gets both.
    assert.equal(tick.cursor, undefined);
    assert.deepEqual(tick.reported, []);
    assert.equal(existsSync(cursorPath(paths.ledgerRoot)), false);
    assert.equal(stub.submissions.length, 0);
  });

  it("run polls until interrupted, then pauses", async () => {
    const paths = sandbox();
    const interruptFlag = { interrupted: false };
    const stub = stubManager();
    stub.onListen = () => {
      if (stub.listens === 2) {
        interruptFlag.interrupted = true;
      }
    };
    const journal = memoryJournal();
    const host = await openHost(optionsFor(paths, stub, { interruptFlag, pollIntervalMs: 10 }), {
      journal,
    });

    const last = await host.run();

    assert.equal(stub.listens, 2);
    assert.equal(last.listenerOutcome, "listened");
    assert.equal(journal.lines.at(-1)?.event, "paused");
  });

  it("run does not listen at all when already interrupted", async () => {
    const paths = sandbox();
    const stub = stubManager({ deliveries: [{ cursor: "1", payload: convertible() }] });
    const journal = memoryJournal();
    const host = await openHost(optionsFor(paths, stub, { interruptFlag: { interrupted: true } }), {
      journal,
    });

    const last = await host.run();

    assert.equal(stub.listens, 0);
    assert.deepEqual(last, { listenerOutcome: "completed", reported: [] });
    // Opening Host is itself filmed; nothing was listened to or driven after it.
    assert.deepEqual(
      journal.lines.map((line) => line.event),
      ["host-started", "paused"],
    );
  });

  it("a gone probe cancels an escalation and starts the queue in the same pass", async () => {
    const paths = sandbox();
    let answer: ProbeResult = "present";
    const stub = stubManager({
      deliveries: [{ cursor: "1", payload: convertible("42") }],
      probe: async (key) => (key === KEY ? answer : "present"),
    });
    const host = await openHost(optionsFor(paths, stub, { builder: blockingBuilder() }));
    assert.ok((await host.runOnce()).reported.includes("escalated"));

    stub.deliveries.push({ cursor: "2", payload: convertible("43") });
    await host.runOnce();
    const waiting = await host.ledger.get("stub:43");
    assert.equal(waiting.ok && waiting.aggregate.state, "received");

    answer = "gone";
    stub.probes.length = 0;
    const tick = await host.runOnce();
    assert.ok(stub.probes.includes(KEY));
    assert.ok(tick.reported.includes("cancelled"));
    const cancelled = await host.ledger.get(KEY);
    assert.equal(cancelled.ok && cancelled.aggregate.state, "cancelled");
    const started = await host.ledger.get("stub:43");
    assert.equal(started.ok && started.aggregate.state, "escalated");
  });

  it("an unavailable probe leaves an escalation in place", async () => {
    const paths = sandbox();
    const stub = stubManager({
      deliveries: [{ cursor: "1", payload: convertible() }],
      probe: async () => "unavailable",
    });
    const host = await openHost(optionsFor(paths, stub, { builder: blockingBuilder() }));
    await host.runOnce();

    stub.probes.length = 0;
    const tick = await host.runOnce();
    assert.deepEqual(stub.probes, [KEY]);
    assert.equal(tick.reported.includes("cancelled"), false);
    const held = await host.ledger.get(KEY);
    assert.equal(held.ok && held.aggregate.state, "escalated");
  });

  it("a listen that missed the source does not probe", async () => {
    const paths = sandbox();
    const stub = stubManager({
      deliveries: [{ cursor: "1", payload: convertible() }],
      probe: async () => "gone",
    });
    const host = await openHost(optionsFor(paths, stub, { builder: blockingBuilder() }));
    await host.runOnce();

    stub.listenOutcome = "source-lost";
    stub.probes.length = 0;
    const tick = await host.runOnce();
    assert.deepEqual(stub.probes, []);
    assert.equal(tick.reported.includes("cancelled"), false);
    const held = await host.ledger.get(KEY);
    assert.equal(held.ok && held.aggregate.state, "escalated");
  });
});
