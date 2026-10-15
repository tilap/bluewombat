import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { listTickets } from "./list-tickets.js";

const feature = { key: "fake:F1", external_id: "F1", project: "proj" };

function sourceWith(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-tickets-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof content === "string" ? content : JSON.stringify(content));
  }
  return dir;
}

describe("listTickets", () => {
  it("reads the Tickets of the Feature, with the signals they carry", () => {
    const source = sourceWith({
      "0001.json": {
        id: "F1",
        project: "proj",
        intention: "a feature",
        tickets: [
          { id: "1", intention: "first" },
          { id: "2", title: "Second", blocked_by: ["1"], priority: 70, task_ready: false },
          { id: 3, intention: "third", resume: true, open: false },
        ],
      },
    });
    const tickets = listTickets(source, feature);
    assert.deepEqual(
      tickets.map((entry) => [entry.ticket.key, entry.task_ready, entry.resume, entry.open]),
      [
        ["fake:1", true, false, true],
        ["fake:2", false, false, true],
        ["fake:3", true, true, false],
      ],
    );
    assert.deepEqual(tickets[1]?.ticket.blocked_by, ["fake:1"]);
    assert.equal(tickets[1]?.ticket.intention, "Second");
    assert.equal(tickets[1]?.ticket.priority, 70);
    assert.equal(tickets[1]?.ticket.project, "proj");
    assert.match(tickets[0]?.ticket.fingerprint ?? "", /^sha256:/);
  });

  it("reads the newest file about the Feature, and ignores the others", () => {
    const source = sourceWith({
      "0001.json": { id: "F1", tickets: [{ id: "1", intention: "old" }] },
      "0002.json": { id: "OTHER", tickets: [{ id: "9", intention: "not ours" }] },
      "0003.json": { id: "F1", kind: "update", tickets: [{ id: "1", intention: "new" }] },
      "0004.json": { id: "F1", kind: "cancel" },
      "0005.json": "not json",
    });
    const tickets = listTickets(source, feature);
    assert.deepEqual(
      tickets.map((entry) => entry.ticket.intention),
      ["new"],
    );
  });

  it("changes a Ticket's fingerprint when its words change, and not otherwise", () => {
    const at = (intention: string) =>
      listTickets(
        sourceWith({ "0001.json": { id: "F1", tickets: [{ id: "1", intention }] } }),
        feature,
      )[0]?.ticket.fingerprint;
    assert.equal(at("same"), at("same"));
    assert.notEqual(at("same"), at("other"));
  });

  it("lists nothing for a Feature with no file, or no tickets, or a bad Ticket", () => {
    assert.deepEqual(listTickets(sourceWith({}), feature), []);
    assert.deepEqual(listTickets(sourceWith({ "0001.json": { id: "F1" } }), feature), []);
    assert.deepEqual(
      listTickets(
        sourceWith({ "0001.json": { id: "F1", tickets: [null, 3, {}, { id: "1" }, []] } }),
        feature,
      ),
      [],
    );
  });
});
