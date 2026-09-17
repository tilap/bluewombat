import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { deserializeRun, extrasOf, findExecutable, readResult, runAgent, serializeRun } from "./agent.js";

function sandbox(): string {
  return mkdtempSync(join(tmpdir(), "slot-kit-"));
}

function executable(dir: string, name: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

/** PATH is the first place `findExecutable` looks, so a test has to own it. */
function withPath<T>(value: string, run: () => T): T {
  const before = process.env.PATH;
  process.env.PATH = value;
  try {
    return run();
  } finally {
    process.env.PATH = before;
  }
}

describe("findExecutable", () => {
  it("finds a name in the extra directories", () => {
    const root = sandbox();
    const path = executable(join(root, "bin"), "cursor-agent", "#!/bin/sh\nexit 0\n");
    assert.equal(
      withPath("", () => findExecutable(["cursor-agent"], [join(root, "bin")])),
      path,
    );
  });

  it("looks on PATH before the extra directories", () => {
    const root = sandbox();
    const onPath = executable(join(root, "path"), "claude", "#!/bin/sh\nexit 0\n");
    executable(join(root, "extra"), "claude", "#!/bin/sh\nexit 0\n");
    const found = withPath(join(root, "path"), () =>
      findExecutable(["claude"], [join(root, "extra")]),
    );
    assert.equal(found, onPath);
  });

  it("is undefined when no name is anywhere", () => {
    assert.equal(
      withPath("", () => findExecutable(["cursor-agent"], [sandbox()])),
      undefined,
    );
  });

  it("prefers a precise name anywhere over a generic one early", () => {
    // `agent` sits in the first directory, `cursor-agent` in the second. The
    // caller listed `cursor-agent` first, so that is the one it gets.
    const root = sandbox();
    const early = join(root, "early");
    const late = join(root, "late");
    executable(early, "agent", "#!/bin/sh\nexit 0\n");
    const precise = executable(late, "cursor-agent", "#!/bin/sh\nexit 0\n");
    const found = withPath("", () => findExecutable(["cursor-agent", "agent"], [early, late]));
    assert.equal(found, precise);
  });

  it("ignores a file that is not executable", () => {
    const root = sandbox();
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "claude"), "not runnable");
    chmodSync(join(root, "claude"), 0o644);
    assert.equal(
      withPath("", () => findExecutable(["claude"], [root])),
      undefined,
    );
  });
});

describe("readResult", () => {
  it("reads the last JSON object on stdout", () => {
    assert.deepEqual(readResult('{"a":1}\n{"b":2}\n'), { b: 2 });
  });

  it("skips trailing lines that are not JSON objects", () => {
    assert.deepEqual(readResult('{"a":1}\nDone.\n'), { a: 1 });
  });

  it("skips a JSON array, which is not a result object", () => {
    assert.deepEqual(readResult('{"a":1}\n[1,2]\n'), { a: 1 });
  });

  it("is undefined when nothing on stdout is an object", () => {
    assert.equal(readResult("just words\n"), undefined);
    assert.equal(readResult(""), undefined);
    assert.equal(readResult("null\n"), undefined);
  });
});

describe("runAgent", () => {
  it("separates the streams and keeps both in arrival order", async () => {
    const root = sandbox();
    const script = join(root, "agent.mjs");
    writeFileSync(
      script,
      'process.stdout.write("out\\n");process.stderr.write("err\\n");process.exit(0);\n',
    );
    const run = await runAgent({ file: process.execPath, args: [script], cwd: root });
    assert.equal(run.code, 0);
    assert.equal(run.stdout, "out\n");
    assert.equal(run.stderr, "err\n");
    assert.equal(run.output.length, "out\nerr\n".length);
    assert.ok(run.durationMs >= 0);
    assert.ok(run.endedAt.getTime() >= run.startedAt.getTime());
  });

  it("reports a non-zero exit rather than throwing", async () => {
    const root = sandbox();
    const script = join(root, "agent.mjs");
    writeFileSync(script, "process.exit(7);\n");
    const run = await runAgent({ file: process.execPath, args: [script], cwd: root });
    assert.equal(run.code, 7);
    assert.equal(run.error, undefined);
  });

  it("reports a CLI that never started", async () => {
    const root = sandbox();
    const run = await runAgent({ file: join(root, "nothing-here"), args: [], cwd: root });
    assert.ok(run.error !== undefined);
    assert.equal(run.code, undefined);
  });

  it("runs in the directory it was given", async () => {
    const root = sandbox();
    const script = join(root, "agent.mjs");
    writeFileSync(script, "process.stdout.write(process.cwd());\n");
    const run = await runAgent({ file: process.execPath, args: [script], cwd: root });
    assert.ok(run.stdout.endsWith(root.replace(/^\/private/, "")) || run.stdout.endsWith(root));
  });
});

describe("serializeRun", () => {
  it("round-trips a finished run, including a start error", () => {
    const startedAt = new Date("2026-09-09T10:00:00.000Z");
    const endedAt = new Date("2026-09-09T10:00:01.000Z");
    const run = {
      code: null,
      signal: null,
      error: new Error("Could not start"),
      stdout: "",
      stderr: "",
      output: "",
      startedAt,
      endedAt,
      durationMs: 1000,
    };
    const serialized = serializeRun(run, { name: "Cursor CLI", bin: "/bin/cursor-agent" });
    assert.equal(serialized.name, "Cursor CLI");
    assert.equal(serialized.error, "Could not start");
    assert.equal(serialized.skills, null);
    assert.equal(serialized.usage, null);
    const restored = deserializeRun(serialized);
    assert.ok(restored !== undefined);
    assert.equal(restored.error?.message, "Could not start");
    assert.equal(restored.startedAt.toISOString(), startedAt.toISOString());
  });

  it("defaults skills and usage to null when the wrapper passes nothing", () => {
    const run = {
      code: 0,
      signal: null,
      stdout: "",
      stderr: "",
      output: "",
      startedAt: new Date("2026-09-09T10:00:00.000Z"),
      endedAt: new Date("2026-09-09T10:00:01.000Z"),
      durationMs: 1000,
    };
    const serialized = serializeRun(run, { name: "agent", bin: "/bin/x" });
    assert.equal(serialized.skills, null);
    assert.equal(serialized.usage, null);
  });

  it("keeps an empty skills list distinct from unknown", () => {
    const run = {
      code: 0,
      signal: null,
      stdout: "",
      stderr: "",
      output: "",
      startedAt: new Date("2026-09-09T10:00:00.000Z"),
      endedAt: new Date("2026-09-09T10:00:01.000Z"),
      durationMs: 1000,
    };
    const none = serializeRun(run, { name: "agent", bin: "/bin/x", skills: [] });
    const unknown = serializeRun(run, { name: "agent", bin: "/bin/x", skills: null });
    assert.deepEqual(none.skills, []);
    assert.equal(unknown.skills, null);
    assert.notDeepEqual(none.skills, unknown.skills);
  });

  it("writes usage when the wrapper supplies it", () => {
    const run = {
      code: 0,
      signal: null,
      stdout: "",
      stderr: "",
      output: "",
      startedAt: new Date("2026-09-09T10:00:00.000Z"),
      endedAt: new Date("2026-09-09T10:00:01.000Z"),
      durationMs: 1000,
    };
    const usage = {
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      costUsd: 0.5,
    };
    const serialized = serializeRun(run, {
      name: "agent",
      bin: "/bin/x",
      skills: ["thin-slice"],
      usage,
    });
    assert.deepEqual(serialized.skills, ["thin-slice"]);
    assert.deepEqual(serialized.usage, usage);
  });

  it("does not treat a pre-run { error } as a run", () => {
    assert.equal(deserializeRun({ error: "no prompt" }), undefined);
  });
});

describe("extrasOf", () => {
  it("reads skills and usage from a serialized line", () => {
    assert.deepEqual(
      extrasOf({
        skills: ["a"],
        usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, costUsd: null },
      }),
      {
        skills: ["a"],
        usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, costUsd: null },
      },
    );
  });

  it("treats a missing or malformed extras field as unknown", () => {
    assert.deepEqual(extrasOf({}), { skills: null, usage: null });
    assert.deepEqual(extrasOf({ skills: [1], usage: { input: "x" } }), {
      skills: null,
      usage: null,
    });
  });
});
