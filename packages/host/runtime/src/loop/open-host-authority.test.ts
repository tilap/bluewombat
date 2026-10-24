import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { GateSpec } from "@bluewombat/implementer";
import type {
  BehindResult,
  Delivery,
  FoldResult,
  LineResult,
  ManagerModule,
  ProbeResult,
  ReportInput,
  SettledResult,
  SubmissionRequest,
  SubmissionResult,
  TicketEntry,
  TicketTrackerPort,
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
const FEATURE = "stub:F1";
const TICKET = "stub:42";
const LINE = "feature/F1";
const TICKET_PR = "pr-ticket";
const LINE_PR = "pr-line";

type Paths = {
  root: string;
  workLineStable: string;
  /** The copy of the line a Feature is folded into. */
  targetStable: string;
  workspaceRoot: string;
  ledgerRoot: string;
};

function sandbox(): Paths {
  const root = mkdtempSync(join(tmpdir(), "host-authority-"));
  const workLineStable = join(root, "stable");
  mkdirSync(workLineStable);
  writeFileSync(join(workLineStable, "seed.txt"), "already good\n");
  const targetStable = join(root, "target");
  mkdirSync(targetStable);
  writeFileSync(join(targetStable, "seed.txt"), "already good\n");
  return {
    root,
    workLineStable,
    targetStable,
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

type StubTicket = {
  id: string;
  intention?: string;
  blocked_by?: string[];
  task_ready?: boolean;
  resume?: boolean;
  open?: boolean;
  e2e?: boolean;
};

/** A Feature as the tracker would deliver it, its Tickets beside it. */
function featurePayload(
  id = "F1",
  over: Record<string, unknown> = {},
  tickets: StubTicket[] = [{ id: "42" }],
): Record<string, unknown> {
  return { id, project: "proj", intention: "a feature", tickets, ...over };
}

type Stub = {
  module: ManagerModule;
  deliveries: Delivery[];
  listens: number;
  reports: ReportInput[];
  submissions: SubmissionRequest[];
  folds: string[];
  lines: string[];
  /** The Tickets of each Feature, as the last delivery of it carried them. */
  ticketsOf: Map<string, StubTicket[]>;
  /** What the Authority says of a Ticket's Submission; the line has its own. */
  submitAnswer: SubmissionResult | undefined;
  lineSubmitAnswer: SubmissionResult | undefined;
  foldAnswer: FoldResult;
  lineAnswer: LineResult;
  settledAnswers: SettledResult[];
  /** What the Authority says of a Submission falling behind, per reference; "current" once the list is empty. */
  behind: Record<string, BehindResult[]>;
  listenOutcome: string;
  probes: string[];
  probe?: (key: string) => Promise<ProbeResult>;
  /** Without Submission methods, so the manager cannot be an Authority. */
  foldsLocally: boolean;
  /** Without a TicketTracker. */
  featuresOnly: boolean;
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
    lines: [],
    ticketsOf: new Map(),
    submitAnswer: undefined,
    lineSubmitAnswer: undefined,
    foldAnswer: { outcome: "folded", reference: "9aeff61" },
    lineAnswer: { outcome: "opened" },
    settledAnswers: ["folded"],
    behind: {},
    listenOutcome: "listened",
    probes: [],
    foldsLocally: false,
    featuresOnly: false,
    ...over,
    module: {
      createManager() {
        const report = async (input: ReportInput): Promise<boolean> => {
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
        };
        const features = {
          async listen() {
            stub.listens += 1;
            stub.onListen?.();
            return { outcome: stub.listenOutcome, deliveries: stub.deliveries.splice(0) };
          },
          async adapt(payload: Record<string, unknown>) {
            if (payload.unavailable === true) {
              return { outcome: "unavailable" as const };
            }
            const id = String(payload.id);
            stub.ticketsOf.set(`stub:${id}`, (payload.tickets as StubTicket[] | undefined) ?? []);
            const kind: "upsert" | "resume" | "cancel" =
              payload.kind === "resume" || payload.kind === "cancel" ? payload.kind : "upsert";
            return {
              outcome: "converted" as const,
              feature: {
                key: `stub:${id}`,
                manager: "stub",
                external_id: id,
                intent: kind,
                project: String(payload.project),
                intention: String(payload.intention),
                priority: typeof payload.priority === "number" ? payload.priority : 50,
                blocked_by: ((payload.blocked_by as string[] | undefined) ?? []).map(
                  (other) => `stub:${other}`,
                ),
                merge_when_ready: payload.merge_when_ready === true,
                skip_e2e: payload.skip_e2e === true,
                fingerprint: `fp-${id}-${String(payload.intention)}`,
                normalized_at: "2026-09-06T10:00:00Z",
              },
            };
          },
          report,
          ...(stub.probe === undefined
            ? {}
            : {
                async probe(key: string) {
                  stub.probes.push(key);
                  return await (stub.probe as (key: string) => Promise<ProbeResult>)(key);
                },
              }),
        };
        if (stub.featuresOnly) {
          return { ok: true, manager: { features } };
        }
        const tickets: TicketTrackerPort = {
          async tickets(feature) {
            const entries: TicketEntry[] = (stub.ticketsOf.get(feature.key) ?? []).map((t) => ({
              ticket: {
                key: `stub:${t.id}`,
                manager: "stub",
                external_id: t.id,
                project: feature.project,
                intention: t.intention ?? "deliver the marker file",
                priority: 50,
                blocked_by: (t.blocked_by ?? []).map((other) => `stub:${other}`),
                fingerprint: `tfp-${t.id}`,
                normalized_at: "2026-09-06T10:00:00Z",
              },
              task_ready: t.task_ready ?? true,
              resume: t.resume ?? false,
              no_tests: false,
              e2e: t.e2e ?? false,
              open: t.open ?? true,
            }));
            return { outcome: "listed", tickets: entries };
          },
          report,
          ...(stub.probe === undefined
            ? {}
            : {
                async probe(key: string) {
                  stub.probes.push(key);
                  return await (stub.probe as (key: string) => Promise<ProbeResult>)(key);
                },
              }),
        };
        if (!stub.foldsLocally) {
          tickets.openLine = async (input) => {
            stub.lines.push(input.line);
            return stub.lineAnswer;
          };
          tickets.submit = async (input) => {
            stub.submissions.push(input);
            const isLine = input.target === TARGET;
            const answer = isLine ? stub.lineSubmitAnswer : stub.submitAnswer;
            return (
              answer ?? {
                outcome: "submitted",
                reference: isLine ? LINE_PR : TICKET_PR,
              }
            );
          };
          tickets.fold = async (input) => {
            stub.folds.push(input.reference);
            return stub.foldAnswer;
          };
          tickets.settled = async () => stub.settledAnswers.shift() ?? "open";
          tickets.behind = async (input) =>
            stub.behind[input.reference]?.shift() ?? { outcome: "current" };
        }
        return { ok: true, manager: { features, tickets } };
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
    featureTracker: { package: stub.module, options: {} },
    ticketTracker: { package: stub.module, options: {} },
    workLineStable: paths.workLineStable,
    workLineTargetStable: paths.targetStable,
    workLineBranch: TARGET,
    workLineIsolation: "@bluewombat/isolation-copy",
    workspaceRoot: paths.workspaceRoot,
    ledgerRoot: paths.ledgerRoot,
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
    ticket: { gates: [] },
    feature: {
      validate: {
        cmd: [node, join(fixtures, "builder-ok.mjs")],
        timeoutMs: 30_000,
        gates: passingGates(),
      },
      gates: passingGates(),
      fix: {
        cmd: [node, join(fixtures, "builder-write-marker.mjs")],
        timeoutMs: 30_000,
        gates: [],
      },
    },
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

const eventsOf = (stub: Stub, key: string): string[] =>
  stub.reports.filter((report) => report.key === key).map((report) => report.event);

describe("host with an Authority", () => {
  it("refreshes a Feature's line against the final line before its first Ticket starts", async () => {
    const paths = sandbox();
    const stub = stubManager({ deliveries: [{ cursor: "1", payload: featurePayload() }] });
    const seen = join(paths.root, "refresher-argv.jsonl");
    const recording = join(paths.root, "recording-refresher.mjs");
    writeFileSync(
      recording,
      `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(seen)}, JSON.stringify(process.argv.slice(2)) + "\\n"); console.log('{"ok":true}');\n`,
    );
    const host = await openHost(
      optionsFor(paths, stub, {
        authority: {
          enabled: true,
          publishArgv: slot(paths.root, "publisher", { ref: "shelf/42" }),
          refreshArgv: [node, recording],
        },
      }),
      { journal: memoryJournal() },
    );

    await host.runOnce();

    const calls = readFileSync(seen, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.deepEqual(calls[0], ["--target", LINE, "--base", TARGET]);
  });

  it("makes a Ticket on the Feature's line, offers it there, folds it, then offers the line", async () => {
    const paths = sandbox();
    const stub = stubManager({ deliveries: [{ cursor: "1", payload: featurePayload() }] });
    const journal = memoryJournal();
    const host = await openHost(optionsFor(paths, stub), { journal });

    const first = await host.runOnce();

    // The Feature opened: a line was cut for it, and its Ticket is with the Authority.
    assert.equal(first.lastRun?.outcome, "paused");
    assert.deepEqual(first.reported, ["accepted", "accepted", "submitted"]);
    assert.deepEqual(stub.lines, [LINE]);
    const opened = await host.ledger.getFeature(FEATURE);
    assert.equal(opened.ok && opened.aggregate.state, "open");
    assert.equal(opened.ok && opened.aggregate.line, LINE);
    const submitted = await host.ledger.get(TICKET);
    assert.equal(submitted.ok && submitted.aggregate.state, "submitted");
    assert.equal(submitted.ok && submitted.aggregate.submission?.reference, TICKET_PR);
    // The Ticket is offered to the line, not to the Project's final one, and
    // under the Publisher's name for the work.
    assert.equal(stub.submissions.length, 1);
    assert.equal(stub.submissions[0]?.ref, "shelf/42");
    assert.equal(stub.submissions[0]?.target, LINE);
    assert.equal(stub.submissions[0]?.intention, "deliver the marker file");
    // The final line is the Authority's to change, not Host's.
    assert.equal(existsSync(join(paths.workLineStable, "delivered.txt")), false);

    // Nothing new from the tracker: the sweep alone drives it on, and the line
    // is offered to the final line once its only Ticket has landed.
    const second = await host.runOnce();

    assert.deepEqual(second.reported, ["done", "progress", "submitted"]);
    assert.deepEqual(stub.folds, [TICKET_PR]);
    const done = await host.ledger.get(TICKET);
    assert.equal(done.ok && done.aggregate.state, "done");
    assert.equal(stub.submissions.length, 2);
    assert.equal(stub.submissions[1]?.target, TARGET);
    const line = await host.ledger.getFeature(FEATURE);
    assert.equal(line.ok && line.aggregate.state, "submitted");
    assert.equal(line.ok && line.aggregate.submission?.reference, LINE_PR);
    assert.deepEqual(eventsOf(stub, FEATURE), ["accepted", "progress", "submitted"]);
    assert.equal(
      stub.reports.find((r) => r.key === FEATURE && r.event === "progress")?.fields.summary,
      "Landed 1 of 1: stub:42",
    );
    assert.deepEqual(
      journal.lines.filter((l) => l.event === "refresh").map((l) => [l.outcome, l.target]),
      [
        ["ok", LINE],
        ["ok", LINE],
        ["ok", LINE],
      ],
    );

    // A human folds the line: the Feature is done, and nothing more is asked.
    const third = await host.runOnce();
    assert.deepEqual(third.reported, ["done"]);
    const finished = await host.ledger.getFeature(FEATURE);
    assert.equal(finished.ok && finished.aggregate.state, "done");
    assert.equal(stub.reports.at(-1)?.fields.reference, LINE_PR);
    assert.deepEqual(stub.folds, [TICKET_PR], "the system folded no line");
  });

  it("waits for the human who folds the line, and starts no other Feature meanwhile", async () => {
    const paths = sandbox();
    const stub = stubManager({
      deliveries: [
        { cursor: "1", payload: featurePayload("F1", { priority: 70 }, [{ id: "42" }]) },
        { cursor: "2", payload: featurePayload("F2", { priority: 10 }, [{ id: "43" }]) },
      ],
      settledAnswers: ["open", "open", "folded"],
    });
    const host = await openHost(optionsFor(paths, stub));

    await host.runOnce();
    await host.runOnce();
    const waiting = await host.runOnce();
    assert.deepEqual(waiting.reported, []);
    assert.deepEqual((await host.runOnce()).reported, []);
    assert.equal((await host.ledger.getFeature(FEATURE)).ok, true);
    const held = await host.ledger.getFeature(FEATURE);
    assert.equal(held.ok && held.aggregate.state, "submitted");
    const second = await host.ledger.getFeature("stub:F2");
    assert.equal(second.ok && second.aggregate.state, "waiting");
    assert.deepEqual(eventsOf(stub, "stub:F2"), []);

    const merged = await host.runOnce();
    assert.deepEqual(merged.reported, ["done"]);

    const next = await host.runOnce();
    assert.ok(next.reported.includes("accepted"));
    assert.deepEqual(stub.lines, [LINE, "feature/F2"]);
    const opened = await host.ledger.getFeature("stub:F2");
    assert.equal(opened.ok && opened.aggregate.state, "open");
  });

  it("folds the line itself when the Feature says it may, once the checks agree", async () => {
    const paths = sandbox();
    const stub = stubManager({
      deliveries: [{ cursor: "1", payload: featurePayload("F1", { merge_when_ready: true }) }],
    });
    const journal = memoryJournal();
    const host = await openHost(optionsFor(paths, stub), { journal });

    await host.runOnce();
    const closing = await host.runOnce();
    assert.deepEqual(closing.reported, ["done", "progress", "submitted"]);

    const folding = await host.runOnce();
    assert.deepEqual(folding.reported, ["done"]);
    assert.deepEqual(stub.folds, [TICKET_PR, LINE_PR]);
    const done = await host.ledger.getFeature(FEATURE);
    assert.equal(done.ok && done.aggregate.state, "done");
    assert.equal(done.ok && done.aggregate.integration_reference, "9aeff61");
    assert.equal(stub.reports.at(-1)?.fields.integration_reference, "9aeff61");
  });

  it("escalates the Feature when the checks on its line refuse it, and folds nothing", async () => {
    const paths = sandbox();
    const stub = stubManager({
      deliveries: [{ cursor: "1", payload: featurePayload("F1", { merge_when_ready: true }) }],
    });
    const host = await openHost(
      optionsFor(paths, stub, {
        ticket: {
          gates: [
            {
              id: "ci",
              argv: [node, join(fixtures, "gate-fail-blocking.mjs")],
              timeoutMs: 10_000,
            },
          ],
        },
      }),
    );
    await host.runOnce();
    // The Ticket is judged by the same sequence, so it escalates first.
    const tick = await host.runOnce();
    assert.ok(tick.reported.includes("escalated"));
    assert.deepEqual(stub.folds, []);
  });

  function defaultFeature(): NonNullable<HostOptions["feature"]> {
    return {
      validate: {
        cmd: [node, join(fixtures, "builder-ok.mjs")],
        timeoutMs: 30_000,
        gates: passingGates(),
      },
      gates: passingGates(),
      fix: {
        cmd: [node, join(fixtures, "builder-write-marker.mjs")],
        timeoutMs: 30_000,
        gates: [],
      },
    };
  }

  /** A Gate that refuses until the repair has put its marker in the line. */
  function needsRepairGate(root: string): GateSpec[] {
    const path = join(root, "needs-repair.mjs");
    writeFileSync(
      path,
      [
        'import { existsSync } from "node:fs";',
        'const ok = existsSync("feature-fixed.txt");',
        "console.log(JSON.stringify(ok",
        '  ? { verdict: "pass" }',
        '  : { verdict: "fail-retryable", report: "the line needs feature-fixed.txt" }));',
        "",
      ].join("\n"),
    );
    return [{ id: "line-check", argv: [node, path], timeoutMs: 10_000 }];
  }

  function script(root: string, name: string, body: string): string[] {
    const path = join(root, `${name}.mjs`);
    writeFileSync(path, body);
    return [node, path];
  }

  function writesRepair(root: string): string[] {
    return script(
      root,
      "repairs",
      'import { writeFileSync } from "node:fs";\nwriteFileSync("feature-fixed.txt", "repaired\\n");\n',
    );
  }

  /** The Ticket has landed and the Feature's line is with the Authority. */
  async function featureSubmitted(host: Awaited<ReturnType<typeof openHost>>): Promise<void> {
    await host.runOnce();
    await host.runOnce();
  }

  async function stateOf(host: Awaited<ReturnType<typeof openHost>>) {
    const got = await host.ledger.getFeature(FEATURE);
    assert.ok(got.ok);
    return got.aggregate;
  }

  it("judges the published line by the Feature's own gates, not the ticket's", async () => {
    const paths = sandbox();
    const stub = stubManager({
      deliveries: [{ cursor: "1", payload: featurePayload("F1", { merge_when_ready: true }) }],
    });
    const host = await openHost(
      optionsFor(paths, stub, {
        // The Ticket's ticket passes; only the Feature's sequence refuses.
        ticket: { gates: [] },
        feature: { ...defaultFeature(), gates: blockingGates() },
      }),
    );
    await featureSubmitted(host);
    await host.runOnce();
    assert.equal((await stateOf(host)).state, "escalated");
    assert.deepEqual(stub.folds, [TICKET_PR]);
  });

  it("brings the final line into the Feature and reviews it before the line is offered", async () => {
    const paths = sandbox();
    // The final line holds a file the Feature's line does not.
    writeFileSync(join(paths.targetStable, "from-target.txt"), "moved on\n");
    const stub = stubManager({
      deliveries: [{ cursor: "1", payload: featurePayload("F1", { merge_when_ready: true }) }],
    });
    // The review's gates run in the Feature's workspace and see what was merged into it.
    const checks = script(
      paths.root,
      "sees-target",
      [
        'import { existsSync, writeFileSync } from "node:fs";',
        'const ok = existsSync("from-target.txt");',
        'writeFileSync(process.env.SEEN ?? "seen.txt", ok ? "yes" : "no");',
        "console.log(JSON.stringify(ok",
        '  ? { verdict: "pass" }',
        '  : { verdict: "fail-blocking", report: "the target was not merged" }));',
        "",
      ].join("\n"),
    );
    const host = await openHost(
      optionsFor(paths, stub, {
        feature: {
          ...defaultFeature(),
          validate: {
            ...defaultFeature().validate,
            gates: [{ id: "target-merged", argv: checks, timeoutMs: 10_000 }],
          },
        },
      }),
    );
    await featureSubmitted(host);
    const feature = await stateOf(host);
    assert.equal(feature.state, "submitted");
    // What was merged is on the Feature's line, which is what gets published.
    assert.equal(existsSync(join(paths.workLineStable, "from-target.txt")), true);
  });

  it("repairs a refused line, publishes it again, and folds it once the gates agree", async () => {
    const paths = sandbox();
    const stub = stubManager({
      deliveries: [{ cursor: "1", payload: featurePayload("F1", { merge_when_ready: true }) }],
    });
    const host = await openHost(
      optionsFor(paths, stub, {
        feature: {
          ...defaultFeature(),
          gates: needsRepairGate(paths.root),
          fix: { cmd: writesRepair(paths.root), timeoutMs: 30_000, gates: [] },
        },
      }),
    );
    await featureSubmitted(host);

    // The judgement refuses: the line goes back to where it is made.
    await host.runOnce();
    const refused = await stateOf(host);
    assert.equal(refused.state, "open");
    assert.equal(refused.submission?.refusals, 1);
    assert.match(refused.submission?.last_report ?? "", /feature-fixed\.txt/);
    assert.deepEqual(stub.folds, [TICKET_PR]);

    // The fix, the align, the review and the offer, on the same Submission.
    await host.runOnce();
    const repaired = await stateOf(host);
    assert.equal(repaired.state, "submitted");
    assert.equal(repaired.submission?.reference, LINE_PR);
    assert.equal(existsSync(join(paths.workLineStable, "feature-fixed.txt")), true);

    await host.runOnce();
    assert.deepEqual(stub.folds, [TICKET_PR, LINE_PR]);
    assert.equal((await stateOf(host)).state, "done");
  });

  it("escalates the Feature when its own rounds are spent", async () => {
    const paths = sandbox();
    const stub = stubManager({
      deliveries: [{ cursor: "1", payload: featurePayload("F1", { merge_when_ready: true }) }],
    });
    const host = await openHost(
      optionsFor(paths, stub, {
        feature: {
          ...defaultFeature(),
          // Never satisfied: the repair writes a file the gate does not look for.
          gates: [
            {
              id: "never",
              argv: [node, join(fixtures, "gate-fail-retryable.mjs")],
              timeoutMs: 10_000,
            },
          ],
          fix: { cmd: writesRepair(paths.root), timeoutMs: 30_000, gates: [] },
          maxRefusals: 2,
        },
      }),
    );
    await featureSubmitted(host);
    await host.runOnce();
    assert.equal((await stateOf(host)).state, "open");
    await host.runOnce();
    assert.equal((await stateOf(host)).state, "submitted");
    await host.runOnce();
    assert.equal((await stateOf(host)).state, "escalated");
    assert.deepEqual(stub.folds, [TICKET_PR]);
  });

  it("runs the gates of feature.validate alone when its agent is turned off", async () => {
    const paths = sandbox();
    const stub = stubManager({
      deliveries: [{ cursor: "1", payload: featurePayload("F1", { merge_when_ready: true }) }],
    });
    // The gate records that it ran, in the Feature's workspace.
    const ran = join(paths.root, "validate-gate-ran.txt");
    const gate = script(
      paths.root,
      "records-run",
      `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(ran)}, "ran\\n");\nconsole.log(JSON.stringify({ verdict: "pass" }));\n`,
    );
    const host = await openHost(
      optionsFor(paths, stub, {
        feature: {
          ...defaultFeature(),
          validate: { agent: false, gates: [{ id: "records", argv: gate, timeoutMs: 10_000 }] },
        },
      }),
    );
    await featureSubmitted(host);
    assert.equal((await stateOf(host)).state, "submitted");
    assert.equal(readFileSync(ran, "utf8"), "ran\n");
  });

  it("goes back to be brought up to date when the final line moved on, then folds", async () => {
    const paths = sandbox();
    const stub = stubManager({
      deliveries: [{ cursor: "1", payload: featurePayload("F1", { merge_when_ready: true }) }],
      behind: { [LINE_PR]: [{ outcome: "behind", commits: 2 }] },
    });
    const host = await openHost(optionsFor(paths, stub));
    await featureSubmitted(host);

    await host.runOnce();
    const behind = await stateOf(host);
    assert.equal(behind.state, "open");
    assert.equal(behind.submission?.realigns, 1);
    assert.deepEqual(stub.folds, [TICKET_PR], "nothing is folded that was not judged");

    await host.runOnce();
    assert.equal((await stateOf(host)).state, "submitted");

    await host.runOnce();
    assert.deepEqual(stub.folds, [TICKET_PR, LINE_PR]);
    assert.equal((await stateOf(host)).state, "done");
  });

  it("sends a conflict with the final line to the fix, which settles it by hand", async () => {
    const paths = sandbox();
    // A file on the Feature's line, a directory of the same name on the final one.
    writeFileSync(join(paths.workLineStable, "clash"), "feature\n");
    mkdirSync(join(paths.targetStable, "clash"));
    writeFileSync(join(paths.targetStable, "clash", "inner.txt"), "target\n");
    const stub = stubManager({
      deliveries: [{ cursor: "1", payload: featurePayload("F1", { merge_when_ready: true }) }],
    });
    // The copy strategy cannot turn a file into a directory and fold it back, so
    // the fix settles it on both sides, as a person editing both would.
    const fix = script(
      paths.root,
      "settles-clash",
      `import { rmSync } from "node:fs";\nrmSync("clash", { force: true });\nrmSync(${JSON.stringify(join(paths.workLineStable, "clash"))}, { force: true });\n`,
    );
    const host = await openHost(
      optionsFor(paths, stub, {
        feature: { ...defaultFeature(), fix: { cmd: fix, timeoutMs: 30_000, gates: [] } },
      }),
    );
    await host.runOnce();
    await host.runOnce();
    // First pass: the align conflicts, and the reason is kept for the fix.
    const parked = await stateOf(host);
    assert.equal(parked.state, "open");
    assert.match(parked.parked_refusal?.report ?? "", /conflicts/);
    assert.equal(parked.parked_refusal?.refused_by, "align");

    // Second pass: the fix settles it, and the line is offered.
    await host.runOnce();
    const offered = await stateOf(host);
    assert.equal(offered.state, "submitted");
    assert.equal(offered.parked_refusal, undefined);
    assert.equal(offered.parked_refusals, 1);
  });

  it("escalates a conflict with the final line when the rounds are spent", async () => {
    const paths = sandbox();
    writeFileSync(join(paths.workLineStable, "clash"), "feature\n");
    mkdirSync(join(paths.targetStable, "clash"));
    writeFileSync(join(paths.targetStable, "clash", "inner.txt"), "target\n");
    const stub = stubManager({
      deliveries: [{ cursor: "1", payload: featurePayload("F1", { merge_when_ready: true }) }],
    });
    const host = await openHost(
      optionsFor(paths, stub, { feature: { ...defaultFeature(), maxRefusals: 1 } }),
    );
    await host.runOnce();
    await host.runOnce();
    const feature = await stateOf(host);
    assert.equal(feature.state, "escalated");
    assert.match(feature.escalation?.report ?? "", /align: .*conflicts/);
  });

  it("escalates the Feature when the line is closed without being folded, and resumes it on ready", async () => {
    const paths = sandbox();
    const stub = stubManager({
      deliveries: [{ cursor: "1", payload: featurePayload() }],
      settledAnswers: ["closed", "folded"],
    });
    const host = await openHost(optionsFor(paths, stub));
    await host.runOnce();
    await host.runOnce();

    const closed = await host.runOnce();
    assert.deepEqual(closed.reported, ["escalated"]);
    const frozen = await host.ledger.getFeature(FEATURE);
    assert.equal(frozen.ok && frozen.aggregate.state, "escalated");
    assert.match(frozen.ok ? (frozen.aggregate.escalation?.report ?? "") : "", /closed without/);

    stub.deliveries.push({ cursor: "2", payload: featurePayload("F1", { kind: "resume" }) });
    const resumed = await host.runOnce();
    assert.ok(resumed.reported.includes("resumed"));
    const back = await host.ledger.getFeature(FEATURE);
    assert.equal(back.ok && back.aggregate.state, "submitted");
    assert.equal(back.ok && back.aggregate.resumes, 1);
    // Offered again: a real Authority answers the pull request that is still open,
    // and opens a new one when the old was closed.
    assert.equal(stub.submissions.length, 3);

    const merged = await host.runOnce();
    assert.deepEqual(merged.reported, ["done"]);
  });

  it("escalates the Feature when the Authority refuses its line", async () => {
    const paths = sandbox();
    const stub = stubManager({
      deliveries: [{ cursor: "1", payload: featurePayload() }],
      lineSubmitAnswer: { outcome: "refused", reason: "no commits between dev and the line" },
    });
    const host = await openHost(optionsFor(paths, stub));
    await host.runOnce();

    const tick = await host.runOnce();

    assert.deepEqual(tick.reported, ["done", "progress", "escalated"]);
    const got = await host.ledger.getFeature(FEATURE);
    assert.equal(got.ok && got.aggregate.state, "escalated");
    assert.match(got.ok ? (got.aggregate.escalation?.report ?? "") : "", /no commits/);
  });

  it("does not open a Feature whose Tickets are not all ready", async () => {
    const paths = sandbox();
    const stub = stubManager({
      deliveries: [
        {
          cursor: "1",
          payload: featurePayload("F1", {}, [{ id: "42" }, { id: "43", task_ready: false }]),
        },
      ],
    });
    const journal = memoryJournal();
    const host = await openHost(optionsFor(paths, stub), { journal });

    const tick = await host.runOnce();

    assert.deepEqual(tick.reported, []);
    assert.deepEqual(stub.lines, []);
    const waiting = await host.ledger.getFeature(FEATURE);
    assert.equal(waiting.ok && waiting.aggregate.state, "waiting");
    assert.equal((await host.ledger.get(TICKET)).ok, false);
    assert.ok(journal.lines.some((line) => line.event === "waiting" && line.key === FEATURE));

    // Written at last: the next pass opens it, with no delivery to say so.
    stub.ticketsOf.set(FEATURE, [{ id: "42" }, { id: "43" }]);
    const next = await host.runOnce();
    assert.ok(next.reported.includes("accepted"));
    const opened = await host.ledger.getFeature(FEATURE);
    assert.equal(opened.ok && opened.aggregate.state, "open");
    assert.deepEqual(opened.ok ? opened.aggregate.tickets : [], [TICKET, "stub:43"]);
  });

  it("makes the Tickets of a Feature in the order their blockers say", async () => {
    const paths = sandbox();
    const stub = stubManager({
      deliveries: [
        {
          cursor: "1",
          payload: featurePayload("F1", {}, [{ id: "43", blocked_by: ["42"] }, { id: "42" }]),
        },
      ],
    });
    const host = await openHost(optionsFor(paths, stub));

    await host.runOnce();
    const first = await host.ledger.get("stub:42");
    assert.equal(first.ok && first.aggregate.state, "submitted");
    const second = await host.ledger.get("stub:43");
    assert.equal(second.ok && second.aggregate.state, "received");
    assert.deepEqual(second.ok ? second.aggregate.intention.blocked_by : [], ["stub:42"]);

    await host.runOnce();
    const done = await host.ledger.get("stub:42");
    assert.equal(done.ok && done.aggregate.state, "done");
    const started = await host.ledger.get("stub:43");
    assert.equal(started.ok && started.aggregate.state, "submitted");
  });

  it("hands the Publisher the name the isolation strategy gave the Child", async () => {
    const paths = sandbox();
    const stub = stubManager({ deliveries: [{ cursor: "1", payload: featurePayload() }] });
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
    assert.equal(argv[argv.indexOf("--ref") + 1], `shelf/${TICKET.replaceAll(":", "-")}`);
    assert.equal(argv[argv.indexOf("--target") + 1], LINE);
    assert.equal(stub.submissions[0]?.ref, "published/42");
  });

  it("says on the tracker that the Submission was refused and a repair is on its way", async () => {
    const paths = sandbox();
    const stub = stubManager({ deliveries: [{ cursor: "1", payload: featurePayload() }] });
    const host = await openHost(
      optionsFor(paths, stub, {
        ticket: {
          maxRefusals: 3,
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
    assert.deepEqual(offered.reported, ["accepted", "accepted", "submitted"]);

    // The judge refuses: the tracker hears it, then Host re-drives the repair
    // and re-offer in the same tick (no poll wait for a local refusal).
    const refused = await host.runOnce();
    assert.equal(refused.lastRun?.outcome, "paused");
    assert.ok(refused.reported.includes("progress"));
    const progress = stub.reports.find(
      (r) =>
        r.key === TICKET &&
        r.event === "progress" &&
        typeof r.fields.summary === "string" &&
        /refused the Submission; a repair is on its way \(refusal 1 of 3\)/.test(r.fields.summary),
    );
    assert.ok(progress !== undefined);
    assert.equal(progress?.fields.stage, "submitting");
    assert.equal(progress?.fields.trace, "lint failed");
    assert.equal(stub.submissions.length, 2);
    const back = await host.ledger.get(TICKET);
    assert.equal(back.ok && back.aggregate.state, "submitted");

    // Taken.
    const done = await host.runOnce();
    assert.ok(done.reported.includes("done"));
    assert.deepEqual(stub.folds, [TICKET_PR]);
  });

  it("escalates at the submitting stage when the Authority refuses the offer", async () => {
    const paths = sandbox();
    const stub = stubManager({
      deliveries: [{ cursor: "1", payload: featurePayload() }],
      submitAnswer: { outcome: "refused", reason: "not now" },
    });
    const host = await openHost(optionsFor(paths, stub));

    const tick = await host.runOnce();

    assert.equal(tick.lastRun?.outcome, "escalated");
    assert.deepEqual(tick.reported, ["accepted", "accepted", "escalated"]);
    assert.equal(stub.reports.at(-1)?.fields.stage, "submitting");
    const got = await host.ledger.get(TICKET);
    assert.equal(got.ok && got.aggregate.state, "escalated");
    assert.equal(got.ok && got.aggregate.escalation?.kind, "submitted");
    assert.equal(stub.folds.length, 0);

    // The Feature waits on the Ticket: it is neither driven nor closed.
    const again = await host.runOnce();
    assert.deepEqual(again.reported, []);
  });

  it("does not refresh the work line on a pass with nothing to drive", async () => {
    const paths = sandbox();
    const stub = stubManager({ deliveries: [] });
    const journal = memoryJournal();
    const host = await openHost(optionsFor(paths, stub), { journal });

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

  it("starts no Ticket when the work line cannot be brought up to date", async () => {
    const paths = sandbox();
    const stub = stubManager({ deliveries: [{ cursor: "1", payload: featurePayload() }] });
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

    assert.equal(tick.lastRun, undefined);
    const waiting = await host.ledger.get(TICKET);
    assert.equal(waiting.ok && waiting.aggregate.state, "received");
    assert.equal(stub.submissions.length, 0);
    const refresh = journal.lines.find((line) => line.event === "refresh");
    assert.equal(refresh?.outcome, "failed");
    assert.equal(refresh?.detail, "diverged");
    assert.equal(refresh?.target, LINE);
  });

  it("leaves the Feature waiting when its line cannot be cut, and says so once", async () => {
    const paths = sandbox();
    const stub = stubManager({
      deliveries: [{ cursor: "1", payload: featurePayload() }],
      lineAnswer: { outcome: "refused", reason: "branch protected" },
    });
    const host = await openHost(optionsFor(paths, stub));

    await host.runOnce();
    await host.runOnce();

    const waiting = await host.ledger.getFeature(FEATURE);
    assert.equal(waiting.ok && waiting.aggregate.state, "waiting");
    assert.deepEqual(
      stub.reports.map((report) => [report.event, report.fields.summary]),
      [["progress", "Its line could not be opened: branch protected"]],
    );
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

  it("a manager that answers only the Features", async () => {
    const paths = sandbox();
    await assert.rejects(
      openHost(optionsFor(paths, stubManager({ featuresOnly: true }))),
      /no TicketTracker/,
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
      openHost(
        optionsFor(paths, stubManager(), {
          featureTracker: { package: refusing, options: {} },
          ticketTracker: { package: refusing, options: {} },
        }),
      ),
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
        { cursor: "2", payload: featurePayload() },
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
    const stub = stubManager({ deliveries: [{ cursor: "1", payload: featurePayload() }] });
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

  it("a gone probe cancels a Feature, and the next one opens in the same pass", async () => {
    const paths = sandbox();
    let answer: ProbeResult = "present";
    const stub = stubManager({
      deliveries: [
        { cursor: "1", payload: featurePayload("F1", { priority: 70 }, [{ id: "42" }]) },
        { cursor: "2", payload: featurePayload("F2", { priority: 10 }, [{ id: "43" }]) },
      ],
      probe: async (key) => (key === FEATURE ? answer : "present"),
    });
    const host = await openHost(optionsFor(paths, stub, { builder: blockingBuilder() }));
    assert.ok((await host.runOnce()).reported.includes("escalated"));
    const waiting = await host.ledger.getFeature("stub:F2");
    assert.equal(waiting.ok && waiting.aggregate.state, "waiting");

    answer = "gone";
    stub.probes.length = 0;
    const tick = await host.runOnce();
    assert.ok(stub.probes.includes(FEATURE));
    assert.ok(tick.reported.includes("cancelled"));
    const cancelled = await host.ledger.getFeature(FEATURE);
    assert.equal(cancelled.ok && cancelled.aggregate.state, "cancelled");
    const ticket = await host.ledger.get(TICKET);
    assert.equal(ticket.ok && ticket.aggregate.state, "cancelled");
    assert.ok(stub.lines.includes(LINE));
    const started = await host.ledger.getFeature("stub:F2");
    assert.equal(started.ok && started.aggregate.state, "open");
    const next = await host.ledger.get("stub:43");
    assert.equal(next.ok && next.aggregate.state, "escalated");
  });

  it("a gone probe on a Ticket abandons it alone", async () => {
    const paths = sandbox();
    let answer: ProbeResult = "present";
    const stub = stubManager({
      deliveries: [
        { cursor: "1", payload: featurePayload("F1", {}, [{ id: "42" }, { id: "43" }]) },
      ],
      probe: async (key) => (key === TICKET ? answer : "present"),
    });
    const host = await openHost(optionsFor(paths, stub, { builder: blockingBuilder() }));
    await host.runOnce();

    answer = "gone";
    const tick = await host.runOnce();
    assert.ok(tick.reported.includes("cancelled"));
    const ticket = await host.ledger.get(TICKET);
    assert.equal(ticket.ok && ticket.aggregate.state, "cancelled");
    const feature = await host.ledger.getFeature(FEATURE);
    assert.equal(feature.ok && feature.aggregate.state, "open");
  });

  it("an unavailable probe leaves an escalation in place", async () => {
    const paths = sandbox();
    const stub = stubManager({
      deliveries: [{ cursor: "1", payload: featurePayload() }],
      probe: async () => "unavailable",
    });
    const host = await openHost(optionsFor(paths, stub, { builder: blockingBuilder() }));
    await host.runOnce();

    stub.probes.length = 0;
    const tick = await host.runOnce();
    assert.ok(stub.probes.includes(FEATURE));
    assert.ok(stub.probes.includes(TICKET));
    assert.equal(tick.reported.includes("cancelled"), false);
    const held = await host.ledger.get(TICKET);
    assert.equal(held.ok && held.aggregate.state, "escalated");
  });

  it("a listen that missed the source does not probe", async () => {
    const paths = sandbox();
    const stub = stubManager({
      deliveries: [{ cursor: "1", payload: featurePayload() }],
      probe: async () => "gone",
    });
    const host = await openHost(optionsFor(paths, stub, { builder: blockingBuilder() }));
    await host.runOnce();

    stub.listenOutcome = "source-lost";
    stub.probes.length = 0;
    const tick = await host.runOnce();
    assert.deepEqual(stub.probes, []);
    assert.equal(tick.reported.includes("cancelled"), false);
    const held = await host.ledger.get(TICKET);
    assert.equal(held.ok && held.aggregate.state, "escalated");
  });

  it("resumes an escalated Ticket when its tracker says resume, and the Feature goes on", async () => {
    const paths = sandbox();
    const stub = stubManager({ deliveries: [{ cursor: "1", payload: featurePayload() }] });
    const blocked = await openHost(optionsFor(paths, stub, { builder: blockingBuilder() }));
    assert.ok((await blocked.runOnce()).reported.includes("escalated"));
    await blocked.close();

    // The human fixed what was wrong and put the Ticket back on its way.
    stub.ticketsOf.set(FEATURE, [{ id: "42", resume: true }]);
    const host = await openHost(optionsFor(paths, stub));
    const tick = await host.runOnce();
    assert.ok(tick.reported.includes("resumed"));
    assert.ok(tick.reported.includes("submitted"));
    const ticket = await host.ledger.get(TICKET);
    assert.equal(ticket.ok && ticket.aggregate.state, "submitted");
    assert.equal(ticket.ok && ticket.aggregate.resumes, 1);
  });
});

/**
 * A Project that proves its Features by an e2e acceptance suite: the shipped Gate, run on the
 * assembled Feature, against a tiny application kept in the work line. The application answers
 * 500 for scenario E2 until the Feature's fix has put `app-fixed.txt` in its tree.
 */
describe("the e2e acceptance check", () => {
  const e2eGate = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../plugins/slots/gates/e2e.mjs",
  );

  const SERVER = [
    'import { createServer } from "node:http";',
    'import { existsSync } from "node:fs";',
    "createServer((req, res) => {",
    '  const id = req.url.split("/").pop();',
    '  const broken = id === "E2" && !existsSync("app-fixed.txt");',
    '  console.log("GET " + req.url + " -> " + (broken ? 500 : 200));',
    "  res.statusCode = broken ? 500 : 200;",
    '  res.end("ok");',
    "}).listen(Number(process.env.E2E_PORT), process.env.E2E_HOST);",
    "",
  ].join("\n");
  const READY = [
    'const r = await fetch("http://" + process.env.E2E_HOST + ":" + process.env.E2E_PORT + "/health").catch(() => undefined);',
    "process.exit(r?.ok ? 0 : 1);",
    "",
  ].join("\n");
  const SUITE = [
    'import { mkdirSync, readFileSync, writeFileSync } from "node:fs";',
    'const ids = JSON.parse(readFileSync("e2e/scenarios.json", "utf8"));',
    "const cases = [];",
    "for (const id of ids) {",
    '  const res = await fetch("http://" + process.env.E2E_HOST + ":" + process.env.E2E_PORT + "/s/" + id);',
    '  const head = "<testcase name=\'" + id + " works\'";',
    '  cases.push(res.ok ? head + "/>" : head + "><failure message=\'got " + res.status + "\'/></testcase>");',
    "}",
    "mkdirSync(process.env.E2E_RESULTS_DIR, { recursive: true });",
    'writeFileSync(process.env.E2E_RESULTS_DIR + "/junit.xml", "<testsuite>" + cases.join("") + "</testsuite>");',
    'process.exit(cases.some((c) => c.includes("failure")) ? 1 : 0);',
    "",
  ].join("\n");

  function e2eSandbox(): Paths {
    const paths = sandbox();
    mkdirSync(join(paths.workLineStable, "e2e"));
    writeFileSync(join(paths.workLineStable, "server.mjs"), SERVER);
    writeFileSync(join(paths.workLineStable, "ready.mjs"), READY);
    writeFileSync(join(paths.workLineStable, "e2e", "suite.mjs"), SUITE);
    writeFileSync(join(paths.workLineStable, "down.mjs"), "");
    // What the e2e Ticket delivers, on the line: the stub Publisher puts no work on it.
    writeFileSync(join(paths.workLineStable, "e2e", "scenarios.json"), '["E1","E2"]');
    return paths;
  }

  function script(root: string, name: string, body: string): string[] {
    const path = join(root, `${name}.mjs`);
    writeFileSync(path, body);
    return [node, path];
  }

  /** The Gate as a Project writes it, with the clause that lets a Feature leave it out. */
  function suiteGate(port: number): NonNullable<HostOptions["feature"]>["validate"]["gates"] {
    process.env.E2E_PORT = String(port);
    return [
      {
        id: "e2e",
        argv: [
          node,
          e2eGate,
          "--up",
          `${node} server.mjs`,
          "--ready",
          `${node} ready.mjs`,
          "--run",
          `${node} e2e/suite.mjs`,
          "--down",
          `${node} down.mjs`,
          "--start-timeout-ms",
          "20000",
        ],
        timeoutMs: 120_000,
        skipWhen: "skip-test-e2e",
      },
    ];
  }

  async function freePort(): Promise<number> {
    const { createServer } = await import("node:net");
    return await new Promise((resolve) => {
      const probe = createServer();
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        probe.close(() => resolve(port));
      });
    });
  }

  async function optionsWithE2e(
    paths: Paths,
    stub: Stub,
    over: { fix?: string[]; maxRefusals?: number } = {},
  ): Promise<HostOptions> {
    const base = optionsFor(paths, stub);
    const formGates: GateSpec[] = [
      { id: "e2e-form", argv: [node, join(fixtures, "gate-pass.mjs")], timeoutMs: 10_000 },
    ];
    const feature = base.feature as NonNullable<HostOptions["feature"]>;
    return {
      ...base,
      builder: {
        ...base.builder,
        e2e: {
          cmd: [node, join(fixtures, "builder-write-marker.mjs")],
          timeoutMs: 30_000,
          gates: formGates,
        },
      },
      feature: {
        ...feature,
        validate: { ...feature.validate, gates: suiteGate(await freePort()) },
        fix: {
          cmd:
            over.fix ??
            script(
              paths.root,
              "repairs-app",
              'import { writeFileSync } from "node:fs";\nwriteFileSync("app-fixed.txt", "fixed\\n");\n',
            ),
          timeoutMs: 30_000,
          gates: [],
        },
        ...(over.maxRefusals === undefined ? {} : { maxRefusals: over.maxRefusals }),
      },
    };
  }

  const TICKETS = [{ id: "42" }, { id: "43", e2e: true, blocked_by: ["42"] }];

  it("refuses a Feature that has neither an e2e Ticket nor the skip label, and opens nothing", async () => {
    const paths = e2eSandbox();
    const stub = stubManager({
      deliveries: [{ cursor: "1", payload: featurePayload("F1", {}, [{ id: "42" }]) }],
    });
    const journal = memoryJournal();
    const host = await openHost(await optionsWithE2e(paths, stub), { journal });

    const tick = await host.runOnce();

    assert.ok(tick.reported.includes("invalid"));
    const refusal = stub.reports.find((r) => r.event === "invalid");
    assert.equal(refusal?.key, FEATURE);
    assert.match(refusal?.fields.reason ?? "", /no e2e Ticket and is not marked skip-test-e2e/);
    const waiting = await host.ledger.getFeature(FEATURE);
    assert.equal(waiting.ok && waiting.aggregate.state, "waiting");
    assert.deepEqual(stub.lines, []);
  });

  it("refuses an e2e Ticket that does not wait for every other Ticket", async () => {
    const paths = e2eSandbox();
    const stub = stubManager({
      deliveries: [
        { cursor: "1", payload: featurePayload("F1", {}, [{ id: "42" }, { id: "43", e2e: true }]) },
      ],
    });
    const host = await openHost(await optionsWithE2e(paths, stub));

    await host.runOnce();

    const refusal = stub.reports.find((r) => r.event === "invalid");
    assert.match(refusal?.fields.reason ?? "", /must be blocked by every other Ticket/);
    assert.match(refusal?.fields.reason ?? "", /stub:42/);
  });

  it("leaves a Project that does not declare the check as it was", async () => {
    const paths = sandbox();
    const stub = stubManager({
      deliveries: [{ cursor: "1", payload: featurePayload("F1", {}, [{ id: "42" }]) }],
    });
    const host = await openHost(optionsFor(paths, stub));

    await host.runOnce();

    const opened = await host.ledger.getFeature(FEATURE);
    assert.equal(opened.ok && opened.aggregate.state, "open");
    assert.equal(
      stub.reports.some((r) => r.event === "invalid"),
      false,
    );
  });

  it("makes the e2e Ticket with its own pass, no tests first, and proves the Feature by the suite", async () => {
    const paths = e2eSandbox();
    const stub = stubManager({
      deliveries: [{ cursor: "1", payload: featurePayload("F1", {}, TICKETS) }],
    });
    const journal = memoryJournal();
    const host = await openHost(await optionsWithE2e(paths, stub), { journal });

    await host.runOnce();
    const e2eTicket = await host.ledger.get("stub:43");
    assert.equal(e2eTicket.ok && e2eTicket.aggregate.intention.e2e, true);
    assert.equal(e2eTicket.ok && e2eTicket.aggregate.intention.no_tests, true);

    // Both Tickets land, the line is checked: E2 is red, the Feature goes to its fix, which
    // repairs the application, and the second run of the suite is green.
    let state: string | undefined;
    for (let i = 0; i < 6 && state !== "submitted" && state !== "done"; i++) {
      await host.runOnce();
      const got = await host.ledger.getFeature(FEATURE);
      state = got.ok ? got.aggregate.state : undefined;
    }
    assert.ok(state === "submitted" || state === "done", `the Feature is ${state}`);
    // The e2e Ticket was judged by its own Gates, and the other Ticket by the shared ones.
    const judgedBy = (task: string) =>
      journal.lines
        .filter((l) => l.event === "gate-finished" && l.task_id === task)
        .map((l) => l.gate_id);
    assert.deepEqual(judgedBy("stub:43"), ["e2e-form"]);
    assert.deepEqual(judgedBy("stub:42"), ["check"]);
    const finished = journal.lines.filter(
      (l) => l.event === "gate-finished" && l.gate_id === "e2e",
    );
    const reports = finished.map((l) => `${l.verdict}: ${String(l.report).split("\n")[0]}`);
    assert.match(reports[0] ?? "", /^fail-retryable: e2e: 1 of 2 scenario\(s\) failed/);
    assert.match(
      reports.at(-1) ?? "",
      /^pass: e2e: 2 scenario\(s\) ran on the assembled feature and passed: E1, E2/,
    );
    assert.equal(existsSync(join(paths.workLineStable, "app-fixed.txt")), true);
  });

  it("escalates the Feature when the suite stays red after the fix", async () => {
    const paths = e2eSandbox();
    const stub = stubManager({
      deliveries: [{ cursor: "1", payload: featurePayload("F1", {}, TICKETS) }],
    });
    const host = await openHost(
      await optionsWithE2e(paths, stub, {
        fix: script(
          paths.root,
          "useless-fix",
          'import { writeFileSync } from "node:fs";\nwriteFileSync("nothing.txt", "x");\n',
        ),
        maxRefusals: 1,
      }),
    );

    for (let i = 0; i < 8; i++) {
      await host.runOnce();
      const got = await host.ledger.getFeature(FEATURE);
      if (got.ok && got.aggregate.state === "escalated") {
        break;
      }
    }
    const got = await host.ledger.getFeature(FEATURE);
    assert.equal(got.ok && got.aggregate.state, "escalated");
    assert.ok(stub.reports.some((r) => r.event === "escalated" && r.key === FEATURE));
  });

  it("honours the skip label put on a Feature that is already open, and cancels the e2e Ticket then", async () => {
    const paths = e2eSandbox();
    const stub = stubManager({
      deliveries: [{ cursor: "1", payload: featurePayload("F1", {}, TICKETS) }],
    });
    const journal = memoryJournal();
    const base = await optionsWithE2e(paths, stub);
    // The first Ticket escalates, so the Feature stays open while a person looks at it.
    const host = await openHost({ ...base, ticket: { gates: blockingGates() } }, { journal });
    await host.runOnce();
    const open = await host.ledger.getFeature(FEATURE);
    assert.equal(open.ok && open.aggregate.state, "open");
    assert.equal(open.ok && open.aggregate.intention.skip_e2e, undefined);

    stub.deliveries.push({
      cursor: "2",
      payload: featurePayload("F1", { skip_e2e: true }, TICKETS),
    });
    await host.runOnce();

    const marked = await host.ledger.getFeature(FEATURE);
    assert.equal(marked.ok && marked.aggregate.intention.skip_e2e, true);
    assert.ok(journal.lines.some((l) => l.event === "skip-e2e" && l.skip === true));
    const suite = await host.ledger.get("stub:43");
    assert.equal(suite.ok && suite.aggregate.state, "cancelled");

    // And taken off again, it is honoured too: the Feature is judged by the suite once more.
    stub.deliveries.push({ cursor: "3", payload: featurePayload("F1", {}, TICKETS) });
    await host.runOnce();
    const unmarked = await host.ledger.getFeature(FEATURE);
    assert.equal(unmarked.ok && unmarked.aggregate.intention.skip_e2e, undefined);
  });

  it("cancels the e2e Ticket of a Feature that skips the check, and does not run the Gate, saying so", async () => {
    const paths = e2eSandbox();
    const stub = stubManager({
      deliveries: [{ cursor: "1", payload: featurePayload("F1", { skip_e2e: true }, TICKETS) }],
    });
    const journal = memoryJournal();
    const traced: string[] = [];
    const host = await openHost(
      { ...(await optionsWithE2e(paths, stub)), write: (text: string) => traced.push(text) },
      { journal },
    );

    for (let i = 0; i < 6; i++) {
      await host.runOnce();
      const got = await host.ledger.getFeature(FEATURE);
      if (got.ok && got.aggregate.state === "submitted") {
        break;
      }
    }

    const cancelled = await host.ledger.get("stub:43");
    assert.equal(cancelled.ok && cancelled.aggregate.state, "cancelled");
    const feature = await host.ledger.getFeature(FEATURE);
    assert.equal(feature.ok && feature.aggregate.state, "submitted");
    assert.equal(
      journal.lines.some((l) => l.event === "gate-finished" && l.gate_id === "e2e"),
      false,
    );
    assert.ok(
      journal.lines.some(
        (l) => l.event === "gate-skipped" && l.gate_id === "e2e" && l.why === "skip-test-e2e",
      ),
    );
    assert.ok(traced.some((line) => /skips the e2e check: ticket stub:43 is cancelled/.test(line)));
    assert.ok(traced.some((line) => /e2e not run: the Feature carries skip-test-e2e/.test(line)));
  });
});
