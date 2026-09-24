import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  coalesceQuiet,
  journalPath,
  openJournalFile,
  parseJournalChunk,
  stampJournal,
} from "./journal.js";

describe("journal", () => {
  it("stamps at and appends one JSON object per line", () => {
    const root = mkdtempSync(join(tmpdir(), "journal-"));
    mkdirSync(root, { recursive: true });
    const journal = openJournalFile(root, () => new Date("2026-09-07T19:12:01.000Z"));
    journal.append({ event: "status", phase: "gating", gate_id: "ci-green" });
    journal.append({ event: "idle" });
    const body = readFileSync(journalPath(root), "utf8");
    assert.deepEqual(
      body
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
      [
        {
          at: "2026-09-07T19:12:01.000Z",
          event: "status",
          phase: "gating",
          gate_id: "ci-green",
        },
        { at: "2026-09-07T19:12:01.000Z", event: "idle" },
      ],
    );
  });

  it("keeps a truncated last line and skips garbage", () => {
    const first = parseJournalChunk('{"event":"listen"}\n{"event":"sta', "");
    assert.deepEqual(first.lines, [{ event: "listen" }]);
    assert.equal(first.remainder, '{"event":"sta');
    const second = parseJournalChunk('tus"}\nnot json\n{"event":"idle"}\n', first.remainder);
    assert.deepEqual(second.lines, [{ event: "status" }, { event: "idle" }]);
    assert.equal(second.remainder, "");
  });
});

describe("stampJournal", () => {
  function memory(): {
    lines: Record<string, unknown>[];
    append: (l: Record<string, unknown>) => void;
  } {
    const lines: Record<string, unknown>[] = [];
    return { lines, append: (line) => lines.push(line) };
  }

  it("puts the run on every line, whatever wrote it", () => {
    const base = memory();
    const journal = stampJournal(base, { run_id: "run-1" });
    journal.append({ event: "host-started" });
    journal.append({ event: "status", task_id: "s1" });
    assert.deepEqual(base.lines, [
      { run_id: "run-1", event: "host-started" },
      { run_id: "run-1", event: "status", task_id: "s1" },
    ]);
  });

  it("a line's own field wins: a Transformer that said it knows better", () => {
    const base = memory();
    const journal = stampJournal(base, { run_id: "run-1", key: "guess" });
    journal.append({ event: "status", key: "fake:42" });
    assert.equal(base.lines[0]?.key, "fake:42");
  });
});

describe("coalesceQuiet", () => {
  function memory(): {
    lines: Record<string, unknown>[];
    append: (l: Record<string, unknown>) => void;
  } {
    const lines: Record<string, unknown>[] = [];
    return { lines, append: (line) => lines.push(line) };
  }

  const quietListen = { event: "listen", outcome: "completed", deliveries: 0 };

  it("holds passes that found nothing and says how many when work arrives", () => {
    const base = memory();
    const journal = coalesceQuiet(base, 60_000, () => 0);
    // Two passes that found nothing: a quiet listen and an idle each time.
    journal.append({ ...quietListen });
    journal.append({ event: "idle" });
    journal.append({ ...quietListen });
    journal.append({ event: "idle" });
    assert.deepEqual(base.lines, [], "nothing written while nothing happens");
    journal.append({ event: "admitted", key: "fake:42" });
    assert.deepEqual(base.lines, [
      { event: "idle", passes: 2 },
      { event: "admitted", key: "fake:42" },
    ]);
  });

  it("beats once per interval, so a watcher still sees the loop turning", () => {
    const base = memory();
    let clock = 0;
    const journal = coalesceQuiet(base, 1_000, () => clock);
    journal.append({ event: "idle" });
    journal.append({ event: "idle" });
    assert.equal(base.lines.length, 0);
    clock = 1_000;
    journal.append({ event: "idle" });
    assert.deepEqual(base.lines, [{ event: "idle", passes: 3 }]);
  });

  it("a listen that did not complete is never quiet, whatever it delivered", () => {
    const base = memory();
    const journal = coalesceQuiet(base, 60_000, () => 0);
    journal.append({ event: "listen", outcome: "source-lost", deliveries: 0 });
    // The one repeated line somebody has to notice: never held, never merged.
    assert.deepEqual(base.lines, [{ event: "listen", outcome: "source-lost", deliveries: 0 }]);
  });

  it("holds nothing when nothing was quiet", () => {
    const base = memory();
    const journal = coalesceQuiet(base, 60_000, () => 0);
    journal.append({ event: "admitted" });
    assert.deepEqual(base.lines, [{ event: "admitted" }]);
  });
});
