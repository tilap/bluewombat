import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProjectRunResult } from "@bluewombat/conductor";
import type { EventName, ReportInput } from "@bluewombat/manager-kit";
import type { TicketAggregate } from "@bluewombat/work-ledger";
import type { HostDeliveryInput } from "./context.js";
import {
  journalTicket,
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

function aggregateOf(over: Partial<TicketAggregate> = {}): TicketAggregate {
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
    resumes: 0,
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
  const manager = {
    async report(input: ReportInput) {
      reports.push(input);
      return answer;
    },
  };
  const reported: EventName[] = [];
  return {
    reports,
    journal,
    input: {
      options: { ticket: { gates: [] } } as unknown as HostDeliveryInput["options"],
      workLine: { stable: STABLE },
      ledger: {} as HostDeliveryInput["ledger"],
      conductor: {} as HostDeliveryInput["conductor"],
      features: {
        ...manager,
        async listen() {
          return { outcome: "listened", deliveries: [] };
        },
        async adapt() {
          return { outcome: "unavailable" as const };
        },
      },
      tickets: {
        ...manager,
        async tickets() {
          return { outcome: "listed" as const, tickets: [] };
        },
      },
      transformers: {} as HostDeliveryInput["transformers"],
      journal: {
        append(line) {
          journal.push(line);
        },
      },
      trace: () => {},
      watcher: {},
      said: new Set<string>(),
      reported,
    },
  };
}

const ESCALATED: ProjectRunResult = { outcome: "escalated", key: KEY };

describe("reporting after a pass", () => {
  it("tells a unit escalation: who refused, how often, what resume does", async () => {
    const refused = {
      ended: "fail-retryable",
      report: "Sensitive paths changed:\n.github/ci.yml",
      refusedBy: "sensitive-path",
    };
    const aggregate = aggregateOf({
      escalation: {
        kind: "unit",
        born_in_merging: false,
        report: `sensitive-path: ${refused.report}`,
      },
      attempts: [
        { number: 1, round: 0, trace: refused },
        { number: 2, round: 0, trace: refused },
        { number: 3, round: 0, trace: refused },
      ],
    });
    const { input, reports } = harness();
    await reportAfterRun(input, ESCALATED, aggregate);
    const fields = reports.find((report) => report.event === "escalated")?.fields;
    assert.equal(
      fields?.reason,
      "sensitive-path refused it 3 times of 3, for the same reason each time. On resume, the work starts again from zero.",
    );
    // The refuser's words, not the verdict, and not the ledger's prefixed copy.
    assert.equal(fields?.trace, refused.report);
    assert.deepEqual(fields?.counters, { attempts: "3 of 3" });

    // A blocking refusal is one Attempt that no retry could have changed.
    const blocking = harness();
    await reportAfterRun(
      blocking.input,
      ESCALATED,
      aggregateOf({
        escalation: { kind: "unit", born_in_merging: false },
        attempts: [
          {
            number: 1,
            round: 0,
            trace: { ended: "fail-blocking", report: "no git", refusedBy: "parent-clean" },
          },
        ],
      }),
    );
    assert.equal(
      blocking.reports[0]?.fields.reason,
      "parent-clean refused it outright, and no further attempt could change that. On resume, the work starts again from zero.",
    );
    assert.deepEqual(blocking.reports[0]?.fields.counters, { attempts: "1 of 3" });
  });

  it("counts this round's Attempts alone after a resume, and says which round it was", async () => {
    const refused = { ended: "fail-retryable" as const, report: "no", refusedBy: "sensitive-path" };
    const aggregate = aggregateOf({
      state: "escalated",
      attempts_used: 6,
      resumes: 1,
      escalation: { kind: "unit", born_in_merging: false, report: "no" },
      attempts: [
        { number: 1, round: 0, trace: refused },
        { number: 2, round: 0, trace: refused },
        { number: 3, round: 0, trace: refused },
        { number: 4, round: 1, trace: refused },
        { number: 5, round: 1, trace: refused },
        { number: 6, round: 1, trace: refused },
      ],
    });
    const { input, reports } = harness();
    await reportAfterRun(input, ESCALATED, aggregate);
    const fields = reports.find((report) => report.event === "escalated")?.fields;
    assert.equal(
      fields?.reason,
      "sensitive-path refused it 3 times of 3, for the same reason each time, in round 2. On resume, the work starts again from zero.",
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

  it("tells a watcher the work is submitted, once, under the Submission's own id", async () => {
    const { input, reports } = harness();
    input.ledger = { get: async () => ({ ok: true, aggregate: aggregateOf() }) } as never;
    await reportMoment(input, { kind: "submitted", key: KEY, reference: "pr-1" });
    assert.equal(reports[0]?.event, "submitted");
    assert.deepEqual(reports[0]?.fields, { reference: "pr-1" });
    assert.equal(reports[0]?.eventId, `${KEY}:submitted:pr-1`);
  });

  it("keeps an Event the manager declined out of what was said", async () => {
    const { input, journal } = harness(false);
    await reportAfterRun(input, { outcome: "done", key: KEY }, aggregateOf({ state: "done" }));
    assert.deepEqual(input.reported, []);
    assert.deepEqual(
      journal.map((line) => line.event),
      ["report-declined"],
    );
  });

  it("reports nothing on idle, paused or refused", async () => {
    const { input, reports } = harness();
    await reportAfterRun(input, { outcome: "idle" }, aggregateOf());
    await reportAfterRun(input, { outcome: "paused" }, aggregateOf());
    await reportAfterRun(input, { outcome: "refused", code: "not-found" }, aggregateOf());
    assert.deepEqual(reports, []);
  });

  it("says a parked ticket.validate refusal is on its way, before any Submission", async () => {
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
      summary: "reviewer refused the assembled work; a repair is on its way (refusal 1 of 3).",
      stage: "integrating",
      trace: "the diff drops the CLI flag",
    });
  });

  it("counts a line that moved on, with the refusals, in the budget it tells", async () => {
    const { input, reports } = harness();
    input.options = { ticket: { maxRefusals: 4 } } as HostDeliveryInput["options"];
    const aggregate = aggregateOf({
      state: "integrating",
      parked_refusal: { report: "TS2322", refused_by: "typecheck" },
      parked_refusals: 1,
      submission: { reference: "pr-1", submitted_at: 1, refusals: 0, realigns: 1 },
    });
    await reportAfterRun(input, { outcome: "paused", key: KEY }, aggregate);
    assert.match(
      String(reports[0]?.fields.summary),
      /typecheck refused the assembled work; a repair is on its way \(refusal 2 of 4\)\./,
    );
  });

  it("says no attempt is left only once the one budget is spent", async () => {
    const reasonOf = async (over: Partial<TicketAggregate>, maxRefusals: number) => {
      const { input, reports } = harness();
      input.options = { ticket: { maxRefusals } } as HostDeliveryInput["options"];
      await reportAfterRun(input, ESCALATED, aggregateOf(over));
      return reports[0]?.fields.reason;
    };
    const stopped = {
      escalation: { kind: "assembly" as const, born_in_merging: false, report: "lint: red" },
    };
    // Nothing spent: it stopped because nothing could fix it, not for lack of attempts.
    assert.equal(await reasonOf(stopped, 4), "The assembled work was refused.");
    // A parked refusal and a line that moved: two of the budget gone, the next is the last.
    assert.equal(
      await reasonOf(
        {
          ...stopped,
          parked_refusals: 1,
          submission: { reference: "pr-1", submitted_at: 1, refusals: 0, realigns: 2 },
        },
        4,
      ),
      "The assembled work was refused and no attempt is left.",
    );
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
      aggregate: TicketAggregate;
      stage: string;
      fields: Record<string, unknown>;
    }[] = [
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
          escalation: { kind: "unit", born_in_merging: false },
          attempts: [
            { number: 1, round: 0, trace: { ended: "fail-blocking" } },
            { number: 2, round: 0 },
          ],
        }),
        stage: "unit",
        fields: { trace: "fail-blocking" },
      },
      {
        // An escalation the ledger did not describe is a unit one, with nothing
        // to point at.
        aggregate: aggregateOf(),
        stage: "unit",
        fields: { trace: "No Trace recorded." },
      },
      {
        // The work itself passed and nothing refused an Attempt: the ledger's
        // own sentence is what the reader gets.
        aggregate: aggregateOf({
          escalation: {
            kind: "unit",
            born_in_merging: false,
            report: "The workspace is gone.",
          },
          attempts: [{ number: 1, round: 0, trace: { ended: "validated" } }],
        }),
        stage: "unit",
        fields: {
          trace: "The workspace is gone.",
          reason: "The workspace is gone. On resume, the work starts again from zero.",
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
    const unit = harness();
    await reportAfterRun(
      unit.input,
      ESCALATED,
      aggregateOf({ escalation: { kind: "unit", born_in_merging: false } }),
    );
    assert.equal(unit.reports[0]?.eventId, `${KEY}:escalated:0:unit`);

    // Refused again after a resume: same Attempt count, another round, another id.
    const again = harness();
    await reportAfterRun(
      again.input,
      ESCALATED,
      aggregateOf({ resumes: 1, escalation: { kind: "unit", born_in_merging: false } }),
    );
    assert.equal(again.reports[0]?.eventId, `${KEY}:escalated:1:unit`);

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
    const reasonFor = async (over: Partial<TicketAggregate>, maxRefusals: number) => {
      const { input, reports } = harness();
      input.options = { ticket: { maxRefusals } } as HostDeliveryInput["options"];
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

describe("where a resumed ticket picks up", () => {
  it("follows the escalation kind", () => {
    const at = (escalation?: TicketAggregate["escalation"]) =>
      resumePointOf(aggregateOf(escalation === undefined ? {} : { escalation }));
    assert.equal(at({ kind: "merging", born_in_merging: true }), "integrating");
    assert.equal(at({ kind: "assembly", born_in_merging: false }), "integrating");
    assert.equal(at({ kind: "unit", born_in_merging: false }), "running");
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

describe("journalTicket", () => {
  it("adds the Submission line only while the ticket is submitted", () => {
    const { input, journal } = harness();
    journalTicket(
      input.journal,
      "paused",
      aggregateOf({
        state: "submitted",
        submission: { reference: "pr-1", submitted_at: 1, refusals: 1 },
      }),
    );
    journalTicket(input.journal, "done", aggregateOf({ state: "done" }));
    assert.deepEqual(journal, [
      { event: "ran", key: KEY, outcome: "paused", state: "submitted" },
      { event: "submitted", key: KEY, reference: "pr-1", refusals: 1 },
      { event: "ran", key: KEY, outcome: "done", state: "done" },
    ]);
  });
});

describe("journalTicket", () => {
  it("writes a waiting Submission once per change, not on every pass", () => {
    const lines: Record<string, unknown>[] = [];
    const journal = { append: (line: Record<string, unknown>) => void lines.push(line) };
    const said = new Set<string>();
    const waiting = aggregateOf({
      state: "submitted",
      submission: { reference: "pr-1", submitted_at: 1, refusals: 0 },
    });
    journalTicket(journal, "paused", waiting, said);
    journalTicket(journal, "paused", waiting, said);
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
    journalTicket(journal, "paused", refused, said);
    assert.equal(
      lines.filter((line) => line.event === "submitted").length,
      2,
      "a refusal is a change",
    );
  });

  it("writes a held Ticket once while its bail still runs", () => {
    const lines: Record<string, unknown>[] = [];
    const journal = { append: (line: Record<string, unknown>) => void lines.push(line) };
    const said = new Set<string>();
    const until = Date.now() + 3_600_000;
    const held = aggregateOf({
      state: "running",
      bail: { expires_at: until },
    });
    journalTicket(journal, "paused", held, said);
    journalTicket(journal, "paused", held, said);
    assert.deepEqual(
      lines.filter((line) => line.event === "held"),
      [{ event: "held", key: KEY, until, state: "running" }],
    );
    assert.equal(lines.filter((line) => line.event === "ran").length, 0);
  });
});
