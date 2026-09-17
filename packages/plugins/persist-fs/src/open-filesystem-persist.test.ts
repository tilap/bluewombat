import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { FeatureAggregate } from "@bluewombat/work-ledger";
import { openFilesystemPersist } from "./open-filesystem-persist.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "persist-fs-"));
}

function sample(key: string): FeatureAggregate {
  return {
    intention: {
      key,
      project: "proj",
      fingerprint: "fp-1",
      priority: 1,
      intention: "do the thing",
    },
    state: "received",
    received_at: 1_000,
    attempts: [],
    attempts_used: 0,
  };
}

describe("openFilesystemPersist", () => {
  it("creates the root directory when it is missing", async () => {
    const root = join(tempRoot(), "nested", "ledger");
    const persist = await openFilesystemPersist({ root });
    const saved = await persist.save("fake:42", sample("fake:42"));
    assert.deepEqual(saved, { ok: true });
    const loaded = await persist.load("fake:42");
    assert.equal(loaded?.intention.key, "fake:42");
  });

  it("throws when root is not absolute", async () => {
    await assert.rejects(
      () => openFilesystemPersist({ root: "relative/ledger" }),
      /absolute directory/,
    );
  });

  it("encodes the key as one path segment", async () => {
    const root = tempRoot();
    const persist = await openFilesystemPersist({ root });
    await persist.save("fake:42", sample("fake:42"));
    assert.deepEqual(
      readdirSync(root).filter((name) => name.endsWith(".json")),
      ["fake%3A42.json"],
    );
  });

  it("load returns undefined for an unknown key", async () => {
    const persist = await openFilesystemPersist({ root: tempRoot() });
    assert.equal(await persist.load("missing:1"), undefined);
  });

  it("save replaces the whole aggregate and load round-trips it", async () => {
    const persist = await openFilesystemPersist({ root: tempRoot() });
    await persist.save("fake:42", sample("fake:42"));
    const next = sample("fake:42");
    next.state = "planning";
    next.bail = { expires_at: 9_000 };
    await persist.save("fake:42", next);
    const loaded = await persist.load("fake:42");
    assert.equal(loaded?.state, "planning");
    assert.equal(loaded?.bail?.expires_at, 9_000);
  });

  it("listSummaries returns one summary per stored key", async () => {
    const persist = await openFilesystemPersist({ root: tempRoot() });
    await persist.save("fake:1", sample("fake:1"));
    const second = sample("fake:2");
    second.intention.priority = 9;
    await persist.save("fake:2", second);
    const summaries = await persist.listSummaries();
    const keys = summaries.map((row) => row.key).sort();
    assert.deepEqual(keys, ["fake:1", "fake:2"]);
    assert.equal(summaries.find((row) => row.key === "fake:2")?.priority, 9);
  });

  it("save leaves a complete JSON document, never a leftover temporary file", async () => {
    const root = tempRoot();
    const persist = await openFilesystemPersist({ root });
    const saved = await persist.save("fake:42", sample("fake:42"));
    assert.deepEqual(saved, { ok: true });
    const names = readdirSync(root);
    assert.equal(
      names.some((name) => name.includes(".tmp") || name.startsWith(".")),
      false,
    );
    const loaded = await persist.load("fake:42");
    assert.equal(loaded?.intention.key, "fake:42");
    assert.equal(loaded?.state, "received");
  });

  it("skips a truncated sibling JSON file when listing", async () => {
    const root = tempRoot();
    const persist = await openFilesystemPersist({ root });
    await persist.save("fake:42", sample("fake:42"));
    writeFileSync(join(root, "broken.json"), "{not-json", "utf8");
    const summaries = await persist.listSummaries();
    assert.deepEqual(
      summaries.map((row) => row.key),
      ["fake:42"],
    );
  });
});
