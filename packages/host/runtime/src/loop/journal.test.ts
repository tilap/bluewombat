import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { journalPath, openJournalFile, parseJournalChunk } from "./journal.js";

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
