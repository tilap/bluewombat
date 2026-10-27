import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { FeatureAggregate, TicketAggregate } from "@bluewombat/work-ledger";
import { buildDossier, INCIDENT_SCHEMA, renderDossier } from "./incident-dossier.js";

const now = new Date("2026-10-25T10:00:00.000Z");

function ticket(key: string, over: Partial<TicketAggregate> = {}): TicketAggregate {
  return {
    intention: {
      key,
      project: "app",
      fingerprint: "f",
      priority: 50,
      intention: `do ${key}`,
      title: `T ${key}`,
    },
    state: "done",
    received_at: 1,
    attempts: [],
    attempts_used: 1,
    resumes: 0,
    ...over,
  };
}

function feature(over: Partial<FeatureAggregate> = {}): FeatureAggregate {
  return {
    kind: "feature",
    intention: {
      key: "gh:a/b#1",
      project: "app",
      fingerprint: "f",
      priority: 50,
      intention: "build it",
      title: "The feature",
      blocked_by: [],
      merge_when_ready: false,
    },
    state: "escalated",
    received_at: 1,
    tickets: ["gh:a/b#2"],
    resumes: 0,
    escalation: {
      report: "featureTest: too many scenarios",
      at: Date.parse("2026-10-25T09:03:33.314Z"),
    },
    ...over,
  };
}

const stop = (key: string, at: string) => [
  {
    event: "gate-finished",
    key,
    task_id: `${key}:validate`,
    attempt: 1,
    gate_id: "lint",
    verdict: "pass",
    report: "",
    at: "2026-10-25T09:03:30.000Z",
  },
  {
    event: "stream-opened",
    key,
    task_id: `${key}:validate`,
    attempt: 1,
    gate_id: "feature-test",
    path: "s/feature-test.ndjson",
    at,
  },
  {
    event: "gate-finished",
    key,
    task_id: `${key}:validate`,
    attempt: 1,
    gate_id: "feature-test",
    verdict: "fail-blocking",
    report: "too many scenarios",
    at,
  },
  { event: "status", key, task_id: `${key}:validate`, phase: "escalated", attempt: 1, at },
];

describe("buildDossier", () => {
  it("names the check that refused, from the journal, for a ledger that names nobody", () => {
    const dossier = buildDossier({
      subject: feature(),
      tickets: [
        ticket("gh:a/b#2", {
          submission: { reference: "https://x/pull/2", submitted_at: 1, refusals: 0 },
        }),
      ],
      journal: stop("gh:a/b#1", "2026-10-25T09:03:33.314Z"),
      now,
    });
    assert.equal(dossier.schema, INCIDENT_SCHEMA);
    assert.equal(dossier.stop.layer, "feature");
    assert.equal(dossier.stop.refused_by, "feature-test");
    assert.equal(dossier.stop.gate?.verdict, "fail-blocking");
    assert.equal(dossier.stop.task_id, "gh:a/b#1:validate");
    assert.equal(dossier.stop.at, "2026-10-25T09:03:33.314Z");
    assert.deepEqual(dossier.stop.sources, ["ledger", "journal"]);
    assert.equal(dossier.tickets?.[0]?.reference, "https://x/pull/2");
  });

  it("prefers what the ledger recorded over what it infers", () => {
    const dossier = buildDossier({
      subject: feature({
        escalation: { report: "x", refused_by: "ci-green", kind: "submitted", at: 1 },
      }),
      tickets: [],
      journal: stop("gh:a/b#1", "2026-10-25T09:03:33.314Z"),
      now,
    });
    assert.equal(dossier.stop.refused_by, "ci-green");
  });

  it("keeps only the last round of a subject that escalated twice", () => {
    const key = "gh:a/b#1";
    const first = stop(key, "2026-10-24T09:00:00.000Z").map((line) => ({
      ...line,
      gate_id: line.gate_id === "feature-test" ? "old" : line.gate_id,
    }));
    const dossier = buildDossier({
      subject: feature({ resumes: 1 }),
      tickets: [],
      journal: [...first, ...stop(key, "2026-10-25T09:03:33.314Z")],
      now,
    });
    assert.equal(dossier.history.escalations, 2);
    assert.equal(dossier.stop.gate?.id, "feature-test");
    assert.ok(dossier.timeline.every((row) => row.gate_id !== "old"));
  });

  it("says what it could not find instead of leaving it out", () => {
    const dossier = buildDossier({ subject: feature(), tickets: [], journal: [], now });
    assert.ok(dossier.gaps.some((gap) => /No journal/.test(gap)));
    assert.equal(dossier.stop.report, "featureTest: too many scenarios");
    assert.deepEqual(dossier.stop.sources, ["ledger"]);
  });

  it("does not call a finished subject stopped", () => {
    const dossier = buildDossier({ subject: ticket("gh:a/b#2"), tickets: [], journal: [], now });
    assert.equal(dossier.stop.layer, "none");
    assert.ok(dossier.gaps.some((gap) => /not escalated/.test(gap)));
  });

  it("reads a ticket's layer from its escalation, and an agent's failure from the journal", () => {
    const key = "gh:a/b#2";
    const dossier = buildDossier({
      subject: ticket(key, {
        state: "escalated",
        escalation: {
          kind: "unit",
          born_in_merging: false,
          report: "MASON_BLOCKED: no test account",
        },
      }),
      tickets: [],
      journal: [
        {
          event: "builder-finished",
          key,
          task_id: key,
          attempt: 1,
          result: { kind: "failed", reason: "exit 1" },
          at: "2026-10-25T09:00:00.000Z",
        },
        {
          event: "status",
          key,
          task_id: key,
          phase: "escalated",
          attempt: 1,
          at: "2026-10-25T09:00:01.000Z",
        },
      ],
      now,
    });
    assert.equal(dossier.stop.layer, "unit");
    assert.equal(dossier.stop.agent?.failure, "failed: exit 1");
  });

  it("finds the stream of the refusing check, its tail, and the agent's marker in a transcript", () => {
    const root = mkdtempSync(join(tmpdir(), "incident-files-"));
    const key = "gh:a/b#1";
    mkdirSync(join(root, "streams", "s"), { recursive: true });
    writeFileSync(
      join(root, "streams", "s", "feature-test.ndjson"),
      `${JSON.stringify({ at: "t", stream: "stdout", text: "line one\n" })}\n${JSON.stringify({ at: "t", stream: "stdout", text: "the verdict\n" })}\n`,
    );
    mkdirSync(join(root, "transcripts", "gh-a-b-1"), { recursive: true });
    writeFileSync(
      join(root, "transcripts", "gh-a-b-1", "x-attempt-1.md"),
      "# gh:a/b#1 · attempt 1\n\n- slot: Cursor CLI\n- exit: 0\n- duration: 3.0s\n\n## stdout\n\n" +
        `${JSON.stringify({ type: "result", result: "all done\\nMASON_VERDICT: VALIDATED" })}\n`,
    );
    const dossier = buildDossier({
      subject: feature(),
      tickets: [],
      journal: stop(key, "2026-10-25T09:03:33.314Z"),
      streamsDir: join(root, "streams"),
      transcriptsDir: join(root, "transcripts"),
      now,
    });
    const refusing = dossier.artifacts.streams.find((row) => row.gate_id === "feature-test");
    assert.equal(refusing?.exists, true);
    assert.match(refusing?.excerpt ?? "", /the verdict/);
    const transcript = dossier.artifacts.transcripts[0];
    assert.equal(transcript?.exit, "0");
    assert.equal(transcript?.slot, "Cursor CLI");
    assert.equal(transcript?.marker, "MASON_VERDICT: VALIDATED");
    assert.match(transcript?.final_message ?? "", /all done/);
  });
});

describe("renderDossier", () => {
  it("quotes the ledger's words verbatim, even when they hold a code fence", () => {
    const dossier = buildDossier({
      subject: feature({ escalation: { report: "see ```x``` here", at: 1 } }),
      tickets: [],
      journal: [],
      now,
    });
    const page = renderDossier(dossier);
    assert.match(page, /^# Incident: gh:a\/b#1 — The feature/);
    assert.match(page, /````text\nsee ```x``` here\n````/);
    assert.match(page, /## Not found/);
  });
});
