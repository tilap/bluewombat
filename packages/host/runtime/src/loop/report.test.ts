import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProjectRunResult } from "@bluewombat/conductor";
import type { EventName, ManagerPort, ReportInput } from "@bluewombat/manager-kit";
import type { FeatureAggregate } from "@bluewombat/work-ledger";
import type { HostDeliveryInput } from "./context.js";
import {
  journalFeature,
  pushReport,
  reportAfterRun,
  reportMoment,
  resumePointOf,
} from "./report.js";

/**
 * What Host tells the tracker after a pass, from the aggregate alone. The
 * manager and the ledger are stand-ins: the mapping is the whole subject.
 */

const KEY = "stub:42";
const STABLE = "/work/line";

function aggregateOf(over: Partial<FeatureAggregate> = {}): FeatureAggregate {
  return {
    intention: {
      key: KEY,
      project: "proj",
      fingerprint: "fp",
      priority: 50,
      intention: "deliver",
    },
    state: "running",
    received_at: 1,
    attempts: [],
    attempts_used: 0,
    ...over,
  };
}

type Harness = {
  input: HostDeliveryInput;
  reports: ReportInput[];
  journal: Record<string, unknown>[];
};

function harness(answer = true): Harness {
  const reports: ReportInput[] = [];
  const journal: Record<string, unknown>[] = [];
  const manager: ManagerPort = {
    async listen() {
      return { outcome: "listened", deliveries: [] };
    },
    async adapt() {
      return { outcome: "unavailable" };
    },
    async report(input) {
      reports.push(input);
      return answer;
    },
  };
  const reported: EventName[] = [];
  return {
    reports,
    journal,
    input: {
      options: {} as HostDeliveryInput["options"],
      workLine: { stable: STABLE },
      ledger: {} as HostDeliveryInput["ledger"],
      conductor: {} as HostDeliveryInput["conductor"],
      manager,
      journal: {
        append(line) {
          journal.push(line);
        },
      },
      trace: () => { },
      watcher: {},
      said: new Set<string>(),
      reported,
    },
  };
}

const ESCALATED: ProjectRunResult = { outcome: "escalated", key: KEY };

describe("reporting after a pass", () => {
  it("tells a Subtask escalation in the Plan's words: what, who refused, how often, what resume does", async () => {
    const refused = {
      ended: "fail-retryable",
      report: "Sensitive paths changed:\n.github/ci.yml",
      refusedBy: "sensitive-path",
    };
    const aggregate = aggregateOf({
      plan: {
        planned_at: "2026-09-13T00:00:00Z",
        subtasks: [
          {
            id: "s1",
            intention: "Run the tests on Node 22 too\n\nAdd a matrix to the workflow.",
            definition_of_done: "both versions run",
            depends_on: [],
            state: "escalated",
          },
        ],
      },
      escalation: {
        kind: "subtask",
        born_in_merging: false,
        subtask_id: "s1",
        report: `sensitive-path: ${refused.report}`,
      },
      attempts: [
        { subtask_id: "s1", number: 1, trace: refused },
        { subtask_id: "s1", number: 2, trace: refused },
        { subtask_id: "s1", number: 3, trace: refused },
      ],
    });
    const { input, reports } = harness();
    await reportAfterRun(input, ESCALATED, aggregate);
    const fields = reports.find((report) => report.event === "escalated")?.fields;
    assert.equal(
      fields?.reason,
      "Run the tests on Node 22 too — sensitive-path refused it 3 times of 3, for the same reason each time. On resume, s1 starts again from zero; what already landed is kept.",
    );
    // The refuser's words, not the verdict, and not the ledger's prefixed copy.
    assert.equal(fields?.trace, refused.report);
    assert.deepEqual(fields?.counters, { attempts: "3 of 3" });
    assert.equal(fields?.unit, "s1");

    // A blocking refusal is one Attempt that no retry could have changed.
    const blocking = harness();
    await reportAfterRun(
      blocking.input,
      ESCALATED,
      aggregateOf({
        escalation: { kind: "subtask", born_in_merging: false, subtask_id: "s1" },
        attempts: [
          {
            subtask_id: "s1",
            number: 1,
            trace: { ended: "fail-blocking", report: "no git", refusedBy: "parent-clean" },
          },
        ],
      }),
    );
    assert.equal(
      blocking.reports[0]?.fields.reason,
      "s1 — parent-clean refused it outright, and no further attempt could change that. On resume, s1 starts again from zero; what already landed is kept.",
    );
    assert.deepEqual(blocking.reports[0]?.fields.counters, { attempts: "1 of 3" });
  });

  it("counts this round's Attempts alone after a resume, and says which round it was", async () => {
    const refused = { ended: "fail-retryable" as const, report: "no", refusedBy: "sensitive-path" };
    const aggregate = aggregateOf({
      state: "escalated",
      attempts_used: 6,
      resumes: 1,
      plan: {
        planned_at: "2026-09-16T00:00:00Z",
        subtasks: [
          {
            id: "s1",
            intention: "Add hello workflow\n\nUnder .github.",
            definition_of_done: "it exists",
            depends_on: [],
            state: "escalated",
          },
        ],
      },
      escalation: { kind: "subtask", born_in_merging: false, subtask_id: "s1", report: "no" },
      attempts: [
        { subtask_id: "s1", number: 1, round: 0, trace: refused },
        { subtask_id: "s1", number: 2, round: 0, trace: refused },
        { subtask_id: "s1", number: 3, round: 0, trace: refused },
        { subtask_id: "s1", number: 4, round: 1, trace: refused },
        { subtask_id: "s1", number: 5, round: 1, trace: refused },
        { subtask_id: "s1", number: 6, round: 1, trace: refused },
      ],
    });
    const { input, reports } = harness();
    await reportAfterRun(input, ESCALATED, aggregate);
    const fields = reports.find((report) => report.event === "escalated")?.fields;
    assert.equal(
      fields?.reason,
      "Add hello workflow — sensitive-path refused it 3 times of 3, for the same reason each time, in round 2. On resume, s1 starts again from zero; what already landed is kept.",
    );
    assert.deepEqual(fields?.counters, { attempts: "3 of 3" });
  });

  it("names the Authority's reference on done, and nothing without one", async () => {
    const withAuthority = harness();
    await reportAfterRun(
      withAuthority.input,
      { outcome: "done", key: KEY },
      aggregateOf({
        state: "done",
        submission: { reference: "pr-1", submitted_at: 1, refusals: 0 },
        integration_reference: "9aeff61",
      }),
    );
    assert.equal(withAuthority.reports[0]?.fields.reference, "pr-1");
    assert.equal(withAuthority.reports[0]?.fields.integration_reference, "9aeff61");

    const local = harness();
    await reportAfterRun(
      local.input,
      { outcome: "done", key: KEY },
      aggregateOf({ state: "done" }),
    );
    // A local fold has no reference; this machine's directory is not one.
    assert.equal(local.reports[0]?.fields.reference, undefined);
    assert.equal(local.reports[0]?.eventId, `${KEY}:done`);
  });

  it("says the Plan once, under an id the manager can recognise again", async () => {
    const { input, reports, journal } = harness(false);
    const planned = aggregateOf({
      plan: {
        planned_at: "2026-09-06T10:00:00Z",
        subtasks: [
          {
            id: "A",
            intention: "first",
            definition_of_done: "a",
            depends_on: [],
            state: "integrated",
          },
          {
            id: "B",
            intention: "second",
            definition_of_done: "b",
            depends_on: ["A"],
            state: "runnable",
          },
        ],
      },
    });

    await reportAfterRun(input, { outcome: "paused", key: KEY }, planned);
    await reportAfterRun(input, { outcome: "paused", key: KEY }, planned);

    assert.equal(reports.length, 2, "asked twice");
    assert.equal(reports[0]?.eventId, `${KEY}:planned:2026-09-06T10:00:00Z`);
    assert.equal(reports[0]?.eventId, reports[1]?.eventId);
    assert.equal(reports[0]?.fields.plan, "1. first\n2. second (after A)");
    // A manager that declined is the one that decides: nothing counts as said,
    // only the attempt is filmed.
    assert.deepEqual(input.reported, []);
    assert.deepEqual(
      journal.map((line) => line.event),
      ["report-declined", "report-declined"],
    );
  });

  it("says what landed in the Plan's own headline, and how far along that is", async () => {
    const { input, reports } = harness();
    const planned = aggregateOf({
      plan: {
        planned_at: "2026-09-06T10:00:00Z",
        subtasks: [
          {
            id: "s1",
            intention: "Add titleCase in src/title-case.js\n\nIt capitalises every word.",
            definition_of_done: "a",
            depends_on: [],
            state: "integrated",
          },
          {
            id: "s2",
            intention: "second",
            definition_of_done: "b",
            depends_on: [],
            state: "runnable",
          },
        ],
      },
    });
    input.ledger = { get: async () => ({ ok: true, aggregate: planned }) } as never;
    await reportMoment(input, {
      kind: "subtask-integrated",
      key: KEY,
      subtaskId: "s1",
      integrated: 1,
      total: 2,
    });
    assert.equal(reports[0]?.event, "progress");
    assert.deepEqual(reports[0]?.fields, {
      summary: "Landed 1 of 2: Add titleCase in src/title-case.js",
    });
    assert.equal(reports[0]?.eventId, `${KEY}:integrated:s1`);
  });

  it("reports nothing on idle, paused or refused without a Plan", async () => {
    const { input, reports } = harness();
    await reportAfterRun(input, { outcome: "idle" }, aggregateOf());
    await reportAfterRun(input, { outcome: "paused" }, aggregateOf());
    await reportAfterRun(input, { outcome: "refused", code: "not-found" }, aggregateOf());
    assert.deepEqual(reports, []);
  });

  it("says a parked assembly.validate refusal is on its way, before any Submission", async () => {
    const { input, reports } = harness();
    const aggregate = aggregateOf({
      state: "integrating",
      parked_refusal: { report: "the diff drops the CLI flag", refused_by: "reviewer" },
      parked_refusals: 1,
    });
    await reportAfterRun(input, { outcome: "paused", key: KEY }, aggregate);
    assert.equal(reports.length, 1);
    assert.equal(reports[0]?.event, "progress");
    assert.equal(reports[0]?.eventId, `${KEY}:refused:parked:1`);
    assert.deepEqual(reports[0]?.fields, {
      summary: "reviewer refused the assembled feature; a repair is on its way (refusal 1 of 3).",
      stage: "integrating",
      trace: "the diff drops the CLI flag",
    });
  });

  it("prefers the parked refusal over a stale Submission report", async () => {
    const { input, reports } = harness();
    const aggregate = aggregateOf({
      state: "integrating",
      submission: { reference: "ref-1", submitted_at: 1, refusals: 1, last_report: "stale" },
      parked_refusal: { report: "fresh" },
      parked_refusals: 1,
    });
    await reportAfterRun(input, { outcome: "paused", key: KEY }, aggregate);
    assert.equal(reports.length, 1);
    assert.equal(reports[0]?.fields.trace, "fresh");
    // The shared budget: one Authority refusal plus this one parked refusal.
    assert.match(String(reports[0]?.fields.summary), /refusal 2 of 3/);
  });

  it("says nothing when integrating with neither a parked nor a Submission refusal", async () => {
    const { input, reports } = harness();
    await reportAfterRun(
      input,
      { outcome: "paused", key: KEY },
      aggregateOf({ state: "integrating" }),
    );
    assert.deepEqual(reports, []);
  });

  it("maps each escalation to the stage a reader should look at", async () => {
    const cases: {
      aggregate: FeatureAggregate;
      stage: string;
      fields: Record<string, unknown>;
    }[] = [
        {
          aggregate: aggregateOf({
            escalation: { kind: "plan", born_in_merging: false },
            invalid: { code: "plan", reason: "two subtasks share an id" },
          }),
          stage: "plan",
          fields: { reason: "two subtasks share an id" },
        },
        {
          // Frozen for an intention edited in flight: the ledger's sentence, not a refusal.
          aggregate: aggregateOf({
            escalation: {
              kind: "plan",
              born_in_merging: false,
              report: "The intention was edited while the work was in flight (now fingerprint fp-2).",
            },
          }),
          stage: "plan",
          fields: {
            reason: "The intention was edited while the work was in flight (now fingerprint fp-2).",
          },
        },
        {
          aggregate: aggregateOf({ escalation: { kind: "plan", born_in_merging: false } }),
          stage: "plan",
          fields: { reason: "The Plan was refused." },
        },
        {
          aggregate: aggregateOf({ escalation: { kind: "merging", born_in_merging: true } }),
          stage: "merging",
          fields: {},
        },
        {
          aggregate: aggregateOf({
            escalation: { kind: "assembly", born_in_merging: false, report: "lint: 3 errors" },
          }),
          stage: "integrating",
          fields: { trace: "lint: 3 errors" },
        },
        {
          aggregate: aggregateOf({
            attempts_used: 2,
            escalation: { kind: "submitted", born_in_merging: false },
            submission: { reference: "pr-1", submitted_at: 1, refusals: 2, last_report: "CI red" },
          }),
          stage: "submitting",
          fields: { trace: "CI red" },
        },
        {
          aggregate: aggregateOf({
            escalation: { kind: "subtask", born_in_merging: false, subtask_id: "B" },
            attempts: [
              { subtask_id: "A", number: 1, trace: { ended: "validated" } },
              { subtask_id: "B", number: 1, trace: { ended: "fail-blocking" } },
              { subtask_id: "B", number: 2 },
            ],
          }),
          stage: "unit",
          fields: { unit: "B", trace: "fail-blocking" },
        },
        {
          // An escalation the ledger did not describe is a Subtask one, with
          // nothing to point at.
          aggregate: aggregateOf(),
          stage: "unit",
          fields: { unit: "unknown", trace: "No Trace recorded." },
        },
        {
          // A fold conflict: the unit passed, no Attempt refused it, so the
          // ledger's own sentence is what the reader gets.
          aggregate: aggregateOf({
            escalation: {
              kind: "subtask",
              born_in_merging: false,
              subtask_id: "B",
              report: "Folding B into the feature hit a conflict.",
            },
            attempts: [{ subtask_id: "B", number: 1, trace: { ended: "validated" } }],
          }),
          stage: "unit",
          fields: {
            unit: "B",
            trace: "Folding B into the feature hit a conflict.",
            reason:
              "B — Folding B into the feature hit a conflict. On resume, B starts again from zero; what already landed is kept.",
          },
        },
      ];
    for (const { aggregate, stage, fields } of cases) {
      const { input, reports } = harness();
      await reportAfterRun(input, ESCALATED, aggregate);
      assert.equal(reports.length, 1, stage);
      const report = reports[0];
      assert.equal(report?.event, "escalated");
      assert.equal(report?.fields.stage, stage);
      for (const [name, value] of Object.entries(fields)) {
        assert.equal(report?.fields[name as keyof typeof report.fields], value, `${stage}.${name}`);
      }
    }
  });

  it("names every escalation by its round and kind, so a restart says it once and a resume says it again", async () => {
    const plan = harness();
    await reportAfterRun(
      plan.input,
      ESCALATED,
      aggregateOf({ escalation: { kind: "plan", born_in_merging: false } }),
    );
    assert.equal(plan.reports[0]?.eventId, `${KEY}:escalated:0:plan`);

    // Refused again after a `ready`: same Attempt count, another round, another id.
    const again = harness();
    await reportAfterRun(
      again.input,
      ESCALATED,
      aggregateOf({ resumes: 1, escalation: { kind: "plan", born_in_merging: false } }),
    );
    assert.equal(again.reports[0]?.eventId, `${KEY}:escalated:1:plan`);

    const subtask = harness();
    await reportAfterRun(
      subtask.input,
      ESCALATED,
      aggregateOf({
        resumes: 2,
        escalation: { kind: "subtask", born_in_merging: false, subtask_id: "s1" },
      }),
    );
    assert.equal(subtask.reports[0]?.eventId, `${KEY}:escalated:2:subtask:s1`);

    for (const kind of ["merging", "assembly"] as const) {
      const { input, reports } = harness();
      await reportAfterRun(
        input,
        ESCALATED,
        aggregateOf({ escalation: { kind, born_in_merging: false } }),
      );
      assert.equal(reports[0]?.eventId, `${KEY}:escalated:0:${kind}`);
    }
  });

  it("names a refused Submission's escalation once per round", async () => {
    const { input, reports } = harness();
    await reportAfterRun(
      input,
      ESCALATED,
      aggregateOf({
        attempts_used: 3,
        escalation: { kind: "submitted", born_in_merging: false, report: "reviewer: no" },
        submission: { reference: "pr-1", submitted_at: 1, refusals: 1, last_report: "older" },
      }),
    );
    assert.equal(reports[0]?.eventId, `${KEY}:escalated:0:submitted`);
    assert.equal(reports[0]?.fields.trace, "reviewer: no", "the escalation's own words win");
  });

  it("says only what the ledger shows about a refused Submission", async () => {
    const reasonFor = async (over: Partial<FeatureAggregate>, maxRefusals: number) => {
      const { input, reports } = harness();
      input.options = { maxRefusals } as HostDeliveryInput["options"];
      await reportAfterRun(input, ESCALATED, aggregateOf(over));
      return reports[0]?.fields;
    };

    // The offer itself was refused: there never was a Submission to review, and
    // no budget was spent — "no attempt is left" would send a reader the wrong way.
    const offer = await reasonFor(
      {
        state: "escalated",
        escalation: {
          kind: "submitted",
          born_in_merging: false,
          report: "Could not publish issue/3: error: RPC failed; HTTP 400",
        },
      },
      2,
    );
    assert.equal(offer?.reason, "The work could not be submitted.");
    assert.equal(offer?.stage, "submitting");
    assert.equal(offer?.trace, "Could not publish issue/3: error: RPC failed; HTTP 400");

    const spent = await reasonFor(
      {
        escalation: { kind: "submitted", born_in_merging: false, report: "ci-green: red" },
        submission: { reference: "pr-1", submitted_at: 1, refusals: 1 },
      },
      2,
    );
    assert.equal(spent?.reason, "The Submission was refused and no attempt is left.");

    // A blocking refusal, or a republish refused, with budget still standing.
    const early = await reasonFor(
      {
        escalation: { kind: "submitted", born_in_merging: false, report: "ci-green: no checks" },
        submission: { reference: "pr-1", submitted_at: 1, refusals: 0 },
      },
      3,
    );
    assert.equal(early?.reason, "The Submission was refused.");
  });
});

describe("where a resumed feature picks up", () => {
  it("follows the escalation kind", () => {
    const at = (escalation?: FeatureAggregate["escalation"]) =>
      resumePointOf(aggregateOf(escalation === undefined ? {} : { escalation }));
    assert.equal(at({ kind: "plan", born_in_merging: false }), "planning");
    assert.equal(at({ kind: "merging", born_in_merging: true }), "integrating");
    assert.equal(at({ kind: "assembly", born_in_merging: false }), "integrating");
    assert.equal(at({ kind: "subtask", born_in_merging: false }), "running");
    assert.equal(at({ kind: "submitted", born_in_merging: false }), "integrating");
    assert.equal(at(undefined), "running");
  });
});

/** The journal lines with the measured duration left out: it is a clock, not a fact. */
function withoutMs(lines: Record<string, unknown>[]): Record<string, unknown>[] {
  return lines.map(({ ms: _ms, ...rest }) => rest);
}

describe("pushReport", () => {
  it("records an Event only once the manager took it", async () => {
    const taken = harness(true);
    await pushReport(taken.input, { event: "accepted", key: KEY, project: "proj", fields: {} });
    assert.deepEqual(taken.input.reported, ["accepted"]);
    assert.deepEqual(withoutMs(taken.journal), [
      { event: "reported", key: KEY, reported: "accepted" },
    ]);

    const declined = harness(false);
    await pushReport(declined.input, { event: "accepted", key: KEY, project: "proj", fields: {} });
    assert.deepEqual(declined.input.reported, []);
    assert.deepEqual(withoutMs(declined.journal), [
      { event: "report-declined", key: KEY, reported: "accepted" },
    ]);
  });

  it("says how long the tracker took, taken or not", async () => {
    // A report once held the work for five minutes and the journal said nothing.
    for (const took of [true, false]) {
      const { input, journal } = harness(took);
      await pushReport(input, { event: "accepted", key: KEY, project: "proj", fields: {} });
      assert.equal(typeof journal[0]?.ms, "number");
    }
  });
});

describe("journalFeature", () => {
  it("adds the Submission line only while the feature is submitted", () => {
    const { input, journal } = harness();
    journalFeature(
      input.journal,
      "paused",
      aggregateOf({
        state: "submitted",
        submission: { reference: "pr-1", submitted_at: 1, refusals: 1 },
      }),
    );
    journalFeature(input.journal, "done", aggregateOf({ state: "done" }));
    assert.deepEqual(journal, [
      { event: "ran", key: KEY, outcome: "paused", state: "submitted" },
      { event: "submitted", key: KEY, reference: "pr-1", refusals: 1 },
      { event: "ran", key: KEY, outcome: "done", state: "done" },
    ]);
  });
});

describe("journalFeature", () => {
  it("writes a waiting Submission once per change, not on every pass", () => {
    const lines: Record<string, unknown>[] = [];
    const journal = { append: (line: Record<string, unknown>) => void lines.push(line) };
    const said = new Set<string>();
    const waiting = aggregateOf({
      state: "submitted",
      submission: { reference: "pr-1", submitted_at: 1, refusals: 0 },
    });
    journalFeature(journal, "paused", waiting, said);
    journalFeature(journal, "paused", waiting, said);
    assert.equal(lines.filter((line) => line.event === "submitted").length, 1);
    assert.equal(
      lines.filter((line) => line.event === "ran").length,
      2,
      "each pass is still a pass",
    );

    const refused = aggregateOf({
      state: "submitted",
      submission: { reference: "pr-1", submitted_at: 1, refusals: 1, last_report: "lint" },
    });
    journalFeature(journal, "paused", refused, said);
    assert.equal(
      lines.filter((line) => line.event === "submitted").length,
      2,
      "a refusal is a change",
    );
  });

  it("writes a held Feature once while its bail still runs", () => {
    const lines: Record<string, unknown>[] = [];
    const journal = { append: (line: Record<string, unknown>) => void lines.push(line) };
    const said = new Set<string>();
    const until = Date.now() + 3_600_000;
    const held = aggregateOf({
      state: "running",
      bail: { expires_at: until },
      plan: {
        planned_at: "2026-01-01T00:00:00.000Z",
        subtasks: [
          {
            id: "A",
            intention: "first",
            definition_of_done: "a",
            depends_on: [],
            state: "running",
          },
        ],
      },
    });
    journalFeature(journal, "paused", held, said);
    journalFeature(journal, "paused", held, said);
    assert.deepEqual(
      lines.filter((line) => line.event === "held"),
      [{ event: "held", key: KEY, until, state: "running" }],
    );
    assert.equal(lines.filter((line) => line.event === "ran").length, 0);
  });
});
