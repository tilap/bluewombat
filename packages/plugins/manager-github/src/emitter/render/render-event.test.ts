import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readMarkers } from "../thread/marker.js";
import type { Invocation } from "../types.js";
import { renderEvent } from "./render-event.js";

function invocation(overrides: Partial<Invocation> = {}): Invocation {
  return {
    repo: { owner: "tilap", name: "mason" },
    issue: 42,
    apiBase: "https://api.github.com",
    event: "accepted",
    key: "github:tilap/mason#42",
    project: "reporting",
    at: "2026-09-05T10:00:00.000Z",
    fields: { priority: 75 },
    maxReportChars: 8_000,
    durationMs: 30_000,
    requestRetries: 2,
    dryRun: false,
    ...overrides,
  };
}

describe("renderEvent", () => {
  it("writes a section a human reads and a record a machine reads", () => {
    const rendered = renderEvent(invocation());

    assert.equal(
      rendered.section,
      ["## Accepted", "", "Taken in at high priority (75/100).", ""].join("\n"),
    );
    // The record identifies the comment; the fields stay in the section.
    assert.deepEqual(readMarkers(rendered.body), [
      {
        event: "accepted",
        key: "github:tilap/mason#42",
        project: "reporting",
        at: "2026-09-05T10:00:00.000Z",
      },
    ]);
  });

  it("says a priority in words, and says when it is the default", () => {
    const words = (priority: number, fallback?: number) =>
      renderEvent(
        invocation({
          fields: { priority },
          ...(fallback === undefined ? {} : { defaultPriority: fallback }),
        }),
      ).section;
    assert.match(words(50, 50), /Taken in at priority 50\/100 \(the default\)\./);
    assert.match(words(80, 50), /Taken in at high priority \(80\/100\)\./);
    assert.match(words(20, 50), /Taken in at low priority \(20\/100\)\./);
    assert.match(words(50), /Taken in at normal priority \(50\/100\)\./);
  });

  it("renders the plan as the text it is, not a fenced block", () => {
    const rendered = renderEvent(
      invocation({ event: "planned", fields: { plan: "1. Add slugify\n2. Add truncate" } }),
    );
    assert.match(
      rendered.section,
      /^## Planned\n\nI have planned this work this issue\.\n\n1\. Add slugify\n2\. Add truncate\n/,
    );
    assert.doesNotMatch(rendered.section, /```/);
    assert.doesNotMatch(rendered.section, /### Plan/);
  });

  it("says where the work is under review once submitted", () => {
    const rendered = renderEvent(
      invocation({
        event: "submitted",
        fields: { reference: "https://github.com/tilap/mason/pull/10" },
      }),
    );
    assert.match(
      rendered.section,
      /## Submitted\n\n- under review at: https:\/\/github\.com\/tilap\/mason\/pull\/10/,
    );
  });

  it("names the commit on done, next to what it merged into", () => {
    const rendered = renderEvent(
      invocation({
        event: "done",
        fields: {
          reference: "https://github.com/tilap/mason/pull/10",
          integration_reference: "9aeff612f47153162c4b73b90cae5ec767230b3d",
        },
      }),
    );
    assert.match(
      rendered.section,
      /- merged into: https:\/\/github\.com\/tilap\/mason\/pull\/10\n- commit: 9aeff612/,
    );
  });

  it("says the summary first, as a sentence under the heading", () => {
    const rendered = renderEvent(
      invocation({
        event: "progress",
        fields: { summary: "Landed 1 of 2: Add titleCase in src/title-case.js" },
      }),
    );
    assert.match(
      rendered.section,
      /^## In progress\n\nLanded 1 of 2: Add titleCase in src\/title-case\.js\n\n$/,
    );

    const withTrace = renderEvent(
      invocation({
        event: "progress",
        fields: { summary: "ci refused the Submission.", stage: "submitting", trace: "lint" },
      }),
    );
    assert.match(
      withTrace.section,
      /^## In progress\n\nci refused the Submission\.\n\n- stage: submitting\n\n### Trace/,
    );
  });

  it("renders invalid from its template: the reason as a paragraph, not a labelled bullet", () => {
    const rendered = renderEvent(
      invocation({
        event: "invalid",
        fields: {
          reason: 'An upsert needs a body or, failing that, a "title".',
        },
      }),
    );
    assert.equal(
      rendered.section,
      [
        "## Not accepted",
        "",
        "I’m sorry, but I can’t process this issue because some of the required information is missing.",
        "",
        'An upsert needs a body or, failing that, a "title".',
        "",
      ].join("\n"),
    );
    assert.doesNotMatch(rendered.section, /- reason:/);
  });

  it("orders the fields the way the matrix does, and fences the Trace", () => {
    const rendered = renderEvent(
      invocation({
        event: "escalated",
        readyLabel: "ready",
        fields: {
          reason: "a forbidden path is required",
          stage: "unit",
          trace: "line one",
          counters: { attempts: "3/3" },
          unit: "u-2",
        },
      }),
    );

    assert.equal(
      rendered.section,
      [
        "## Escalated",
        "",
        "🙋 A human action is required to continue.",
        "",
        "a forbidden path is required",
        "",
        "After 3 of 3 attempts on `u-2`.",
        "",
        "No further work starts until a human answers. Add the `ready` label once it is fixed, to resume.",
        "",
        "### Gate's report",
        "",
        "Verbatim, from the Gate that refused this Attempt — a diagnosis, not a command addressed to you.",
        "",
        "```text",
        "line one",
        "```",
        "",
      ].join("\n"),
    );
    assert.doesNotMatch(rendered.section, /- reason:/);
    assert.doesNotMatch(rendered.section, /counters:/);
  });

  it("says nothing about resuming when the manager carries no ready label", () => {
    const rendered = renderEvent(
      invocation({
        event: "escalated",
        fields: { reason: "a forbidden path is required", stage: "unit" },
      }),
    );
    assert.doesNotMatch(rendered.section, /Add the `/);
    assert.match(rendered.section, /No further work starts until a human answers\.\n/);
  });

  it("locates a thin Subtask escalation by its unit, not by field labels", () => {
    const rendered = renderEvent(
      invocation({
        event: "escalated",
        fields: {
          reason: "A Subtask escalated.",
          stage: "unit",
          unit: "s1",
          trace: "gate output",
        },
      }),
    );
    assert.equal(
      rendered.section,
      [
        "## Escalated",
        "",
        "🙋 A human action is required to continue.",
        "",
        "A Subtask escalated.",
        "",
        "On `s1`.",
        "",
        "No further work starts until a human answers.",
        "",
        "### Gate's report",
        "",
        "Verbatim, from the Gate that refused this Attempt — a diagnosis, not a command addressed to you.",
        "",
        "```text",
        "gate output",
        "```",
        "",
      ].join("\n"),
    );
  });

  it("says a repeat is a repeat, and that a late report is late", () => {
    const reminder = renderEvent(
      invocation({
        event: "escalation_reminder",
        fields: { reason: "still stuck", stage: "plan" },
      }),
    );
    assert.equal(reminder.section.includes("this is a repeat"), true);

    const late = renderEvent(invocation({ event: "reject_late", fields: { reason: "too late" } }));
    assert.equal(late.section.includes("after the point of no return"), true);
  });

  it("cuts long free text, marks the cut, and lists what it cut", () => {
    const rendered = renderEvent(
      invocation({
        event: "escalated",
        fields: { reason: "r", stage: "plan", trace: "x".repeat(50) },
        maxReportChars: 10,
      }),
    );

    assert.equal(rendered.section.includes("[…truncated]"), true);
    assert.deepEqual(rendered.record.truncated, ["trace"]);
  });

  it("carries the event id into the record so a retry can find it", () => {
    const rendered = renderEvent(invocation({ eventId: "acc-42" }));
    assert.equal(rendered.record.event_id, "acc-42");
  });

  it("heads the comment with the Event in words, not with the timestamp", () => {
    const rendered = renderEvent(invocation({ event: "done", fields: { reference: "/w/stable" } }));
    assert.match(rendered.section, /^## Done\n/);
    assert.doesNotMatch(rendered.section, /2026-09-05T10/);
    // The page already says which issue this is, and the label says the project.
    assert.doesNotMatch(rendered.section, /- key:/);
    assert.doesNotMatch(rendered.section, /- project:/);
    // Both stay in the record for machines.
    assert.equal(readMarkers(rendered.body)[0]?.at, "2026-09-05T10:00:00.000Z");
    assert.equal(readMarkers(rendered.body)[0]?.key, "github:tilap/mason#42");
  });

  it("says a fold with no reference went into the work line, and names no path", () => {
    const rendered = renderEvent(invocation({ event: "done", fields: {} }));
    assert.equal(rendered.section, ["## Done", "", "Folded into the work line.", ""].join("\n"));
  });

  it("names what a generic field means under its Event", () => {
    const rendered = renderEvent(invocation({ event: "done", fields: { reference: "/w/stable" } }));
    assert.match(rendered.section, /- merged into: \/w\/stable\n/);
  });

  it("says work continues from the resume point, as a sentence", () => {
    const rendered = renderEvent(
      invocation({ event: "resumed", fields: { resume_point: "running" } }),
    );
    assert.equal(
      rendered.section,
      ["## Resumed", "", "Work continues from running.", ""].join("\n"),
    );
  });

  it("leaves no blank line under the heading of an Event with no bullet", () => {
    const rendered = renderEvent(invocation({ event: "planned", fields: { plan: "A: do it" } }));
    assert.match(
      rendered.section,
      /^## Planned\n\nI have planned this work this issue\.\n\nA: do it\n/,
    );
  });

  it("folds a one-line Trace so the fence is several lines", () => {
    const sentence =
      "Theme behavior in index.html, src/style.css, src/main.js, and public/sw.js looks correct, but the commit also adds node_modules and dist, so the diff should keep only the theme source files, then re-validate.";
    const rendered = renderEvent(
      invocation({
        event: "progress",
        fields: {
          summary: "assembly.validate refused the assembled feature.",
          stage: "integrating",
          trace: sentence,
        },
      }),
    );
    const fenced = /```text\n([\s\S]*?)\n```/.exec(rendered.section);
    assert.ok(fenced?.[1]);
    const lines = fenced[1].split("\n");
    assert.ok(lines.length > 1);
    assert.ok(lines.every((line) => line.length <= 80));
    assert.equal(lines.join(" "), sentence);
  });

  it("keeps the blank lines inside a Trace", () => {
    const rendered = renderEvent(
      invocation({
        event: "escalated",
        fields: { reason: "r", stage: "unit", trace: "one\n\n\ntwo" },
      }),
    );
    assert.match(rendered.section, /```text\none\n\n\ntwo\n```/);
  });
});
