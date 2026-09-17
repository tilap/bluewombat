import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { IsolationBackend } from "../isolate/backend.js";
import type { Invocation } from "../types.js";
import { runIsolator } from "./run-isolator.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures");
const node = process.execPath;

function sandbox(): string {
  return mkdtempSync(join(tmpdir(), "isolator-run-"));
}

function copyParent(files: Record<string, string> = { "a.txt": "hello", "nested/b.txt": "b" }): {
  parent: string;
  root: string;
} {
  const root = sandbox();
  const parent = join(root, "parent");
  mkdirSync(parent);
  for (const [relative, content] of Object.entries(files)) {
    const path = join(parent, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return { parent, root };
}

function childPath(root: string): string {
  return join(root, "child");
}

function baseInvocation(
  over: Partial<Invocation> & Pick<Invocation, "parent" | "child">,
): Invocation {
  return {
    id: "feat-1",
    durationMs: 30_000,
    ...over,
  };
}

function collectLines(): {
  write: (line: Record<string, unknown>) => void;
  lines: Record<string, unknown>[];
} {
  const lines: Record<string, unknown>[] = [];
  return {
    lines,
    write: (line) => {
      lines.push(line);
    },
  };
}

function readTree(root: string, relative: string): string {
  return readFileSync(join(root, relative), "utf8");
}

/** Inline attach: copies Parent working files into Child. No strategy package. */
const fakeCopy: IsolationBackend = {
  async attach(input) {
    const stop = input.shouldStop();
    if (stop !== undefined) {
      return { ok: false, stop };
    }
    mkdirSync(input.child, { recursive: true });
    const walk = (from: string, to: string): void => {
      mkdirSync(to, { recursive: true });
      for (const name of readdirSync(from)) {
        const src = join(from, name);
        const dest = join(to, name);
        if (statSync(src).isDirectory()) {
          walk(src, dest);
        } else {
          copyFileSync(src, dest);
        }
      }
    };
    walk(input.parent, input.child);
    return { ok: true };
  },
  async abort() {},
};

describe("runIsolator acceptance", () => {
  it("1. Parent working files are snapshotted; Parent unchanged", async () => {
    const { parent, root } = copyParent({
      "a.txt": "hello",
      "nested/b.txt": "b",
    });
    const child = childPath(root);
    const result = await runIsolator({
      backend: fakeCopy,
      invocation: baseInvocation({ parent, child }),
      write: () => {},
    });
    assert.equal(result.outcome, "isolated");
    assert.equal(result.exitCode, 0);
    assert.equal(result.child, child);
    assert.equal(readTree(child, "a.txt"), "hello");
    assert.equal(readTree(child, "nested/b.txt"), "b");
    assert.equal(readTree(parent, "a.txt"), "hello");
    assert.equal(readTree(parent, "nested/b.txt"), "b");
  });

  it("2. After isolated, a file written only under the Child is absent from the Parent", async () => {
    const { parent, root } = copyParent();
    const child = childPath(root);
    const result = await runIsolator({
      backend: fakeCopy,
      invocation: baseInvocation({ parent, child }),
      write: () => {},
    });
    assert.equal(result.outcome, "isolated");
    writeFileSync(join(child, "only-child.txt"), "child");
    assert.equal(existsSync(join(parent, "only-child.txt")), false);
  });

  it("3. After isolated, a file written only under the Parent is absent from the Child", async () => {
    const { parent, root } = copyParent();
    const child = childPath(root);
    const result = await runIsolator({
      backend: fakeCopy,
      invocation: baseInvocation({ parent, child }),
      write: () => {},
    });
    assert.equal(result.outcome, "isolated");
    writeFileSync(join(parent, "only-parent.txt"), "parent");
    assert.equal(existsSync(join(child, "only-parent.txt")), false);
  });

  it("4. --child already exists → invalid-invocation; that directory unchanged", async () => {
    const { parent, root } = copyParent();
    const child = childPath(root);
    mkdirSync(child);
    writeFileSync(join(child, "keep.txt"), "keep");
    const { parseArgs } = await import("../args/parse-args.js");
    const parsed = parseArgs([
      "--id",
      "feat-1",
      "--parent",
      parent,
      "--child",
      child,
      "--duration-ms",
      "1000",
      "--strategy",
      "@bluewombat/isolation-copy",
    ]);
    assert.equal(parsed.ok, false);
    assert.equal(readFileSync(join(child, "keep.txt"), "utf8"), "keep");
    assert.equal(readTree(parent, "a.txt"), "hello");
  });

  it("5. Missing Parent, relative path, empty --id, nested paths → invalid-invocation", async () => {
    const { parseArgs } = await import("../args/parse-args.js");
    const { parent, root } = copyParent();
    const strategy = ["--strategy", "@bluewombat/isolation-copy"] as const;

    const missing = parseArgs([
      "--id",
      "feat-1",
      "--parent",
      join(root, "nope"),
      "--child",
      childPath(root),
      "--duration-ms",
      "1",
      ...strategy,
    ]);
    assert.equal(missing.ok, false);

    const relative = parseArgs([
      "--id",
      "feat-1",
      "--parent",
      "relative",
      "--child",
      childPath(root),
      "--duration-ms",
      "1",
      ...strategy,
    ]);
    assert.equal(relative.ok, false);

    const emptyId = parseArgs([
      "--id",
      "",
      "--parent",
      parent,
      "--child",
      childPath(root),
      "--duration-ms",
      "1",
      ...strategy,
    ]);
    assert.equal(emptyId.ok, false);

    const nested = parseArgs([
      "--id",
      "feat-1",
      "--parent",
      parent,
      "--child",
      join(parent, "inside"),
      "--duration-ms",
      "1",
      ...strategy,
    ]);
    assert.equal(nested.ok, false);
    assert.equal(existsSync(join(parent, "inside")), false);

    const noStrategy = parseArgs([
      "--id",
      "feat-1",
      "--parent",
      parent,
      "--child",
      childPath(root),
      "--duration-ms",
      "1",
    ]);
    assert.equal(noStrategy.ok, false);
  });

  it("6. Interrupt during creation → interrupted; Child gone; Parent remains", async () => {
    const { parent, root } = copyParent();
    const child = childPath(root);
    const flag = { interrupted: false };
    const { write } = collectLines();
    const wrappedWrite = (line: Record<string, unknown>): void => {
      write(line);
      if (line.event === "isolation-started") {
        flag.interrupted = true;
      }
    };
    const result = await runIsolator({
      backend: fakeCopy,
      invocation: baseInvocation({ parent, child }),
      write: wrappedWrite,
      interruptFlag: flag,
    });
    assert.equal(result.outcome, "interrupted");
    assert.equal(result.exitCode, 130);
    assert.equal(existsSync(child), false);
    assert.equal(readTree(parent, "a.txt"), "hello");
  });

  it("7. Isolation clock fires during creation → failed; Child gone; Parent remains", async () => {
    const { parent, root } = copyParent();
    const child = childPath(root);
    let calls = 0;
    const result = await runIsolator({
      backend: fakeCopy,
      invocation: baseInvocation({ parent, child, durationMs: 100 }),
      write: () => {},
      now: () => {
        const value = calls === 0 ? 0 : 10_000;
        calls += 1;
        return value;
      },
    });
    assert.equal(result.outcome, "failed");
    assert.equal(result.exitCode, 1);
    assert.equal(result.report, "The Isolation clock fired.");
    assert.equal(existsSync(child), false);
    assert.equal(readTree(parent, "a.txt"), "hello");
  });

  it("8. never deletes the Parent; never deletes an isolated Child", async () => {
    const { parent, root } = copyParent();
    const child = childPath(root);
    const result = await runIsolator({
      backend: fakeCopy,
      invocation: baseInvocation({ parent, child }),
      write: () => {},
    });
    assert.equal(result.outcome, "isolated");
    assert.ok(existsSync(parent));
    assert.ok(existsSync(child));
    assert.equal(existsSync(join(child, "isolator-own.txt")), false);
  });

  it("9. A Child can be the Parent of a later Isolation", async () => {
    const { parent, root } = copyParent({ "a.txt": "v1" });
    const child1 = join(root, "child-1");
    const first = await runIsolator({
      backend: fakeCopy,
      invocation: baseInvocation({ parent, child: child1 }),
      write: () => {},
    });
    assert.equal(first.outcome, "isolated");
    writeFileSync(join(child1, "from-first.txt"), "yes");
    const child2 = join(root, "child-2");
    const second = await runIsolator({
      backend: fakeCopy,
      invocation: baseInvocation({ id: "feat-2", parent: child1, child: child2 }),
      write: () => {},
    });
    assert.equal(second.outcome, "isolated");
    assert.equal(readTree(child2, "a.txt"), "v1");
    assert.equal(readTree(child2, "from-first.txt"), "yes");
    assert.equal(existsSync(join(parent, "from-first.txt")), false);
  });

  it("10. isolating:feat-1 on stdout and via --on-status", async () => {
    const { parent, root } = copyParent();
    const child = childPath(root);
    const statusLog = join(root, "status.log");
    process.env.ON_STATUS_LOG = statusLog;
    try {
      const { write, lines } = collectLines();
      const result = await runIsolator({
        backend: fakeCopy,
        invocation: baseInvocation({
          parent,
          child,
          onStatusArgv: [node, join(fixtures, "on-status-log.mjs")],
        }),
        write,
      });
      assert.equal(result.outcome, "isolated");
      assert.ok(lines.some((l) => l.event === "status" && l.label === "isolating:feat-1"));
      const logged = readFileSync(statusLog, "utf8");
      assert.ok(logged.includes("isolating:feat-1"));
    } finally {
      delete process.env.ON_STATUS_LOG;
    }
  });

  it("11. --on-status exiting non-zero does not change an isolated Isolation", async () => {
    const { parent, root } = copyParent();
    const child = childPath(root);
    const result = await runIsolator({
      backend: fakeCopy,
      invocation: baseInvocation({
        parent,
        child,
        onStatusArgv: [node, join(fixtures, "on-status-fail.mjs")],
      }),
      write: () => {},
    });
    assert.equal(result.outcome, "isolated");
    assert.ok(existsSync(child));
  });

  it("15. missing Child containing directory is created; isolated", async () => {
    const { parent, root } = copyParent({ "a.txt": "nested" });
    const child = join(root, "missing-a", "missing-b", "child");
    const result = await runIsolator({
      backend: fakeCopy,
      invocation: baseInvocation({ parent, child }),
      write: () => {},
    });
    assert.equal(result.outcome, "isolated");
    assert.equal(readTree(child, "a.txt"), "nested");
  });

  it("stop signal racing the clock uses interrupted", async () => {
    const { parent, root } = copyParent();
    const child = childPath(root);
    const flag = { interrupted: true };
    let calls = 0;
    const result = await runIsolator({
      backend: fakeCopy,
      invocation: baseInvocation({ parent, child, durationMs: 100 }),
      write: () => {},
      interruptFlag: flag,
      now: () => {
        const value = calls === 0 ? 0 : 10_000;
        calls += 1;
        return value;
      },
    });
    assert.equal(result.outcome, "interrupted");
    assert.equal(existsSync(child), false);
  });

  it("passes the Isolation id to the backend", async () => {
    const { parent, root } = copyParent();
    const child = childPath(root);
    let seenId: string | undefined;
    const backend: IsolationBackend = {
      async attach(input) {
        seenId = input.id;
        mkdirSync(input.child);
        return { ok: true };
      },
      async abort() {},
    };
    const result = await runIsolator({
      backend,
      invocation: baseInvocation({ parent, child, id: "github:tilap/mason#2" }),
      write: () => {},
    });
    assert.equal(result.outcome, "isolated");
    assert.equal(seenId, "github:tilap/mason#2");
  });
});
