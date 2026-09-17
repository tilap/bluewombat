import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { slugOf } from "../thread/slug.js";
import type { Invocation } from "../types.js";
import { runEmitter } from "./run-emitter.js";

function targetDir(): string {
  return mkdtempSync(join(tmpdir(), "feature-emitter-run-"));
}

function invocation(target: string, overrides: Partial<Invocation> = {}): Invocation {
  return {
    target,
    event: "accepted",
    key: "fake:42",
    project: "reporting",
    at: "2026-09-05T10:00:00.000Z",
    fields: { priority: 75 },
    maxReportChars: 8_000,
    dryRun: false,
    ...overrides,
  };
}

function collect(): {
  write: (line: Record<string, unknown>) => void;
  lines: Record<string, unknown>[];
} {
  const lines: Record<string, unknown>[] = [];
  return { write: (line) => lines.push(line), lines };
}

function threadFiles(target: string, key: string): { records: string; page: string } {
  const slug = slugOf(key);
  return {
    records: readFileSync(join(target, `${slug}.ndjson`), "utf8"),
    page: readFileSync(join(target, `${slug}.md`), "utf8"),
  };
}

describe("runEmitter", () => {
  it("creates both Thread files, the page starting with the key", () => {
    const target = targetDir();
    const { write } = collect();
    const result = runEmitter({ invocation: invocation(target), write });

    assert.equal(result.outcome, "reported");
    assert.equal(result.exitCode, 0);
    const files = threadFiles(target, "fake:42");
    assert.equal(JSON.parse(files.records.trim()).event, "accepted");
    assert.match(files.page, /^# fake:42\n\n## 2026-09-05T10:00:00\.000Z — accepted\n/);
  });

  it("appends further Events to the same Thread, in call order", () => {
    const target = targetDir();
    const { write } = collect();
    runEmitter({ invocation: invocation(target), write });
    runEmitter({
      invocation: invocation(target, {
        event: "planned",
        at: "2026-09-05T11:00:00.000Z",
        fields: { plan: "two units" },
      }),
      write,
    });

    const files = threadFiles(target, "fake:42");
    const events = files.records
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).event);
    assert.deepEqual(events, ["accepted", "planned"]);
    assert.equal(files.page.match(/^## /gm)?.length, 2);
    assert.equal(files.page.match(/^# fake:42$/gm)?.length, 1);
    assert.deepEqual(readdirSync(target).length, 2);
  });

  it("never lets two keys share a Thread", () => {
    const target = targetDir();
    const { write } = collect();
    runEmitter({ invocation: invocation(target, { key: "fake:42" }), write });
    runEmitter({ invocation: invocation(target, { key: "fake/42" }), write });

    assert.equal(readdirSync(target).length, 4);
  });

  it("reports a repeated --event-id as duplicate, writing nothing twice", () => {
    const target = targetDir();
    const { write } = collect();
    const first = runEmitter({ invocation: invocation(target, { eventId: "acc-42" }), write });
    const second = runEmitter({ invocation: invocation(target, { eventId: "acc-42" }), write });

    assert.equal(first.outcome, "reported");
    assert.equal(second.outcome, "duplicate");
    assert.equal(second.exitCode, 0);
    const files = threadFiles(target, "fake:42");
    assert.equal(files.records.trim().split("\n").length, 1);
    assert.equal(files.page.match(/^## /gm)?.length, 1);
  });

  it("appends twice without an --event-id: two calls are two Events", () => {
    const target = targetDir();
    const { write } = collect();
    runEmitter({ invocation: invocation(target), write });
    runEmitter({ invocation: invocation(target), write });

    assert.equal(threadFiles(target, "fake:42").records.trim().split("\n").length, 2);
  });

  it("renders the exact bytes under --dry-run and touches nothing", () => {
    const target = targetDir();
    const preview = collect();
    const previewed = runEmitter({
      invocation: invocation(target, { dryRun: true }),
      write: preview.write,
    });

    assert.equal(previewed.outcome, "rendered");
    assert.equal(readdirSync(target).length, 0);

    const real = collect();
    runEmitter({ invocation: invocation(target), write: real.write });
    const files = threadFiles(target, "fake:42");
    const render = preview.lines.find((line) => line.event === "render");
    assert.equal(render?.line, files.records);
    assert.equal(render?.section, files.page);
  });

  it("reports unreportable, exit 1, when the Target cannot be written", () => {
    const target = targetDir();
    chmodSync(target, 0o500);
    const { write } = collect();
    const result = runEmitter({ invocation: invocation(target), write });
    chmodSync(target, 0o700);

    // Running as root defeats the permission bit; then the append simply works.
    if (result.outcome === "unreportable") {
      assert.equal(result.exitCode, 1);
      assert.equal(typeof result.detail, "string");
    } else {
      assert.equal(result.outcome, "reported");
    }
  });

  it("writes nothing when interrupted before the first append", () => {
    const target = targetDir();
    const { write } = collect();
    const result = runEmitter({
      invocation: invocation(target),
      write,
      interruptFlag: { interrupted: true },
    });

    assert.equal(result.outcome, "interrupted");
    assert.equal(result.exitCode, 130);
    assert.equal(readdirSync(target).length, 0);
  });

  it("names the Thread on the result line", () => {
    const target = targetDir();
    const { write, lines } = collect();
    runEmitter({ invocation: invocation(target), write });

    const result = lines.find((line) => line.event === "result");
    assert.equal(result?.thread, slugOf("fake:42"));
    assert.equal(result?.key, "fake:42");
    assert.equal(result?.project, "reporting");
  });

  it("carries a Trace into both surfaces", () => {
    const target = targetDir();
    const { write } = collect();
    runEmitter({
      invocation: invocation(target, {
        event: "escalated",
        fields: {
          reason: "a forbidden path is required",
          stage: "unit",
          unit: "u-2",
          trace: "attempt 3 of 3\nthe check refused",
          counters: { attempts: "3/3" },
        },
      }),
      write,
    });

    const files = threadFiles(target, "fake:42");
    assert.equal(JSON.parse(files.records.trim()).trace, "attempt 3 of 3\nthe check refused");
    assert.match(files.page, /### Trace\n\n```text\nattempt 3 of 3\nthe check refused\n```/);
    assert.match(files.page, /frozen: no further work starts/);
  });
});
