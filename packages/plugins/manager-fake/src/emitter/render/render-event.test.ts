import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Invocation } from "../types.js";
import { renderEvent } from "./render-event.js";

function invocation(overrides: Partial<Invocation> = {}): Invocation {
  return {
    target: "/tmp/target",
    event: "escalated",
    key: "fake:42",
    project: "reporting",
    at: "2026-09-05T10:00:00.000Z",
    fields: {},
    maxReportChars: 8_000,
    dryRun: false,
    ...overrides,
  };
}

describe("renderEvent", () => {
  it("carries key, project and timestamp on every Event", () => {
    const rendered = renderEvent(invocation({ event: "done", fields: { reference: "rev-9" } }));
    assert.deepEqual(rendered.record, {
      event: "done",
      key: "fake:42",
      project: "reporting",
      at: "2026-09-05T10:00:00.000Z",
      reference: "rev-9",
    });
  });

  it("leaves absent fields out of the record", () => {
    const rendered = renderEvent(invocation({ event: "invalid", fields: { reason: "no id" } }));
    assert.equal("trace" in rendered.record, false);
    assert.equal("event_id" in rendered.record, false);
  });

  it("writes one section headed by the timestamp and the Event", () => {
    const rendered = renderEvent(invocation({ event: "invalid", fields: { reason: "no id" } }));
    assert.match(rendered.section, /^## 2026-09-05T10:00:00\.000Z — invalid\n/);
    assert.match(rendered.section, /- project: reporting\n/);
    assert.match(rendered.section, /- reason: no id\n/);
  });

  it("puts the Trace and the plan in a fenced block, not a bullet", () => {
    const rendered = renderEvent(
      invocation({
        fields: { reason: "refused", stage: "unit", trace: "line one\nline two" },
      }),
    );
    assert.match(rendered.section, /### Trace\n\n```text\nline one\nline two\n```/);
    assert.doesNotMatch(rendered.section, /- trace:/);
  });

  it("renders counters as name=value pairs", () => {
    const rendered = renderEvent(
      invocation({
        fields: { reason: "out of attempts", stage: "plan", counters: { attempts: "3/3" } },
      }),
    );
    assert.match(rendered.section, /- counters: attempts=3\/3\n/);
    assert.deepEqual(rendered.record.counters, { attempts: "3/3" });
  });

  it("says an escalated Feature is frozen", () => {
    assert.match(
      renderEvent(invocation({ fields: { reason: "refused", stage: "plan" } })).section,
      /frozen: no further work starts/,
    );
  });

  it("says a reminder is a repeat", () => {
    assert.match(
      renderEvent(
        invocation({
          event: "escalation_reminder",
          fields: { reason: "refused", stage: "plan" },
        }),
      ).section,
      /repeat of an earlier escalation/,
    );
  });

  it("says a late rejection arrived after the point of no return", () => {
    assert.match(
      renderEvent(invocation({ event: "reject_late", fields: { reason: "already merged" } }))
        .section,
      /after the point of no return/,
    );
  });

  it("truncates long free text, marks it, and lists what was cut", () => {
    const rendered = renderEvent(
      invocation({
        maxReportChars: 10,
        fields: { reason: "x".repeat(50), stage: "unit", trace: "y".repeat(50) },
      }),
    );
    assert.deepEqual(rendered.record.truncated, ["reason", "trace"]);
    assert.equal(rendered.record.reason, `${"x".repeat(10)} […truncated]`);
    assert.match(rendered.section, /y{10} \[…truncated\]/);
  });

  it("does not mark text that fits", () => {
    const rendered = renderEvent(invocation({ event: "invalid", fields: { reason: "short" } }));
    assert.equal("truncated" in rendered.record, false);
  });

  it("emits one JSON line, newline included", () => {
    const rendered = renderEvent(invocation({ event: "done", fields: { reference: "rev-9" } }));
    assert.equal(rendered.line.endsWith("\n"), true);
    assert.equal(rendered.line.trim().split("\n").length, 1);
    assert.deepEqual(JSON.parse(rendered.line), rendered.record);
  });

  it("keeps --event-id in the record", () => {
    const rendered = renderEvent(
      invocation({ event: "done", eventId: "done-42", fields: { reference: "rev-9" } }),
    );
    assert.equal(rendered.record.event_id, "done-42");
  });
});
