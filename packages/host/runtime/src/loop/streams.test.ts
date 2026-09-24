import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Journal } from "./journal.js";
import { openStreams } from "./streams.js";

function memoryJournal(): Journal & { lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  return {
    lines,
    append(line) {
      lines.push(line);
    },
  };
}

function root(): string {
  return mkdtempSync(join(tmpdir(), "streams-"));
}

/**
 * Let the write stream reach the disk.
 *
 * `createWriteStream` opens its descriptor asynchronously, so a file named here
 * does not exist the instant `open` returns. That is the point of this level —
 * it must never make a Task wait — and it is why the journal names the path
 * rather than a reader deriving it.
 */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

/** The one file a sink opened, read back. */
function onlyFile(dir: string): { path: string; body: string } {
  const featureDirs = readdirSync(dir);
  assert.equal(featureDirs.length, 1, `one directory under ${dir}`);
  const featureDir = join(dir, featureDirs[0] ?? "");
  const files = readdirSync(featureDir);
  assert.equal(files.length, 1, `one file under ${featureDir}`);
  const path = join(featureDir, files[0] ?? "");
  return { path, body: readFileSync(path, "utf8") };
}

describe("streams", () => {
  it("writes one stamped object per chunk, naming which stream it came from", async () => {
    const dir = root();
    const journal = memoryJournal();
    const streams = openStreams({ dir, keep: ["stdout", "stderr"], journal });

    const sink = streams.open({ key: "fake:42", id: "s1", attempt: 1 });
    assert.ok(sink);
    sink.write("stderr", "thinking\n");
    sink.write("stdout", '{"ok":true}\n');
    sink.close();
    await settle();

    const lines = onlyFile(dir)
      .body.trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(lines.length, 2);
    assert.equal(lines[0]?.stream, "stderr");
    assert.equal(lines[0]?.text, "thinking\n");
    assert.equal(lines[1]?.stream, "stdout");
    assert.match(String(lines[0]?.at), /^\d{4}-\d{2}-\d{2}T/);
  });

  it("files a Task under its feature, the way a transcript is filed", async () => {
    const dir = root();
    const streams = openStreams({ dir, keep: ["stderr"], journal: memoryJournal() });

    streams.open({ key: "github:tilap/mason-test#67", id: "s1", attempt: 2 })?.close();
    await settle();

    assert.deepEqual(readdirSync(dir), ["github-tilap-mason-test-67"]);
    const [file] = readdirSync(join(dir, "github-tilap-mason-test-67"));
    assert.match(String(file), /^s1-attempt-2-\d{8}T\d{6}Z\.ndjson$/);
  });

  it("a Gate's film names the Gate, so two of them do not share a file", async () => {
    const dir = root();
    const streams = openStreams({ dir, keep: ["stderr"], journal: memoryJournal() });

    streams.open({ key: "fake:42", id: "s1", attempt: 1, gateId: "npm-test" })?.close();
    await settle();

    const [file] = readdirSync(join(dir, "fake-42"));
    assert.match(String(file), /^s1-attempt-1-gate-npm-test-/);
  });

  it("names the file it opened in the journal, so nothing has to guess it", async () => {
    const dir = root();
    const journal = memoryJournal();
    const streams = openStreams({ dir, keep: ["stderr"], journal });

    streams.open({ key: "fake:42", id: "s1", attempt: 1 })?.close();
    await settle();

    const opened = journal.lines.find((line) => line.event === "stream-opened");
    assert.equal(opened?.key, "fake:42");
    assert.equal(opened?.task_id, "s1");
    assert.equal(opened?.attempt, 1);
    // Relative to the stream directory: the absolute path is this machine's.
    assert.equal(String(opened?.path).startsWith("fake-42/"), true);
    assert.equal(onlyFile(dir).path.endsWith(String(opened?.path)), true);
  });

  it("a Task with no feature is filed apart rather than dropped", () => {
    const dir = root();
    const streams = openStreams({ dir, keep: ["stderr"], journal: memoryJournal() });

    streams.open({ id: "breakdown" })?.close();

    assert.deepEqual(readdirSync(dir), ["no-context"]);
  });

  it("keeps only the streams it was asked for", async () => {
    const dir = root();
    const streams = openStreams({ dir, keep: ["stderr"], journal: memoryJournal() });

    const sink = streams.open({ key: "fake:42", id: "s1", attempt: 1 });
    sink?.write("stdout", "dropped\n");
    sink?.write("stderr", "kept\n");
    sink?.close();
    await settle();

    const body = onlyFile(dir).body;
    assert.match(body, /kept/);
    assert.doesNotMatch(body, /dropped/);
  });

  it("keeping nothing opens nothing", () => {
    const dir = root();
    const journal = memoryJournal();
    const streams = openStreams({ dir, keep: [], journal });

    assert.equal(streams.open({ key: "fake:42", id: "s1", attempt: 1 }), undefined);
    assert.deepEqual(journal.lines, []);
  });

  it("a directory that cannot be made leaves the run unfilmed, not stopped", () => {
    // A file where the directory should be: opening must answer nothing rather
    // than throw into the Task that is working.
    const dir = join(root(), "wherever");
    const streams = openStreams({
      dir: join(dir, "\0bad"),
      keep: ["stderr"],
      journal: memoryJournal(),
    });

    assert.equal(streams.open({ key: "fake:42", id: "s1", attempt: 1 }), undefined);
  });

  it("writing after close is dropped rather than thrown", () => {
    const dir = root();
    const streams = openStreams({ dir, keep: ["stderr"], journal: memoryJournal() });

    const sink = streams.open({ key: "fake:42", id: "s1", attempt: 1 });
    sink?.close();
    sink?.close();
    assert.doesNotThrow(() => sink?.write("stderr", "too late\n"));
  });

  it("says what a film held when it closes, so the bytes can go later", async () => {
    const dir = root();
    const journal = memoryJournal();
    const streams = openStreams({ dir, keep: ["stdout", "stderr"], journal });

    const sink = streams.open({ key: "fake:42", id: "s1", attempt: 1 });
    sink?.write("stderr", "thinking\n");
    sink?.write("stderr", "still thinking\n");
    sink?.close();
    await settle();

    const closed = journal.lines.find((line) => line.event === "stream-closed");
    assert.equal(closed?.key, "fake:42");
    assert.equal(closed?.task_id, "s1");
    assert.equal(closed?.chunks, 2);
    assert.equal(closed?.bytes, "thinking\n".length + "still thinking\n".length);
    assert.equal(typeof closed?.ms, "number");
  });

  it("closing twice says it once", async () => {
    const dir = root();
    const journal = memoryJournal();
    const streams = openStreams({ dir, keep: ["stderr"], journal });

    const sink = streams.open({ key: "fake:42", id: "s1", attempt: 1 });
    sink?.close();
    sink?.close();
    await settle();

    assert.equal(journal.lines.filter((line) => line.event === "stream-closed").length, 1);
  });

  it("discards one Feature's films and says how much there was", async () => {
    const dir = root();
    const journal = memoryJournal();
    const streams = openStreams({ dir, keep: ["stderr"], journal });

    const sink = streams.open({ key: "fake:42", id: "s1", attempt: 1 });
    sink?.write("stderr", "something\n");
    sink?.close();
    streams.open({ key: "other:7", id: "s1", attempt: 1 })?.close();
    await settle();

    streams.discard("fake:42");

    assert.equal(existsSync(join(dir, "fake-42")), false);
    assert.equal(existsSync(join(dir, "other-7")), true, "another Feature is untouched");
    const dropped = journal.lines.find((line) => line.event === "streams-discarded");
    assert.equal(dropped?.key, "fake:42");
    assert.equal(dropped?.files, 1);
    assert.ok(Number(dropped?.bytes) > 0);
  });

  it("discarding what was never filmed says nothing", () => {
    const dir = root();
    const journal = memoryJournal();
    const streams = openStreams({ dir, keep: ["stderr"], journal });

    streams.discard("fake:42");

    assert.deepEqual(journal.lines, []);
  });
});
