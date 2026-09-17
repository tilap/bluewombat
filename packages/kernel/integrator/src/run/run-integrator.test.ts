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
import type { FoldBackend } from "../fold/backend.js";
import type { Invocation } from "../types.js";
import { runIntegrator } from "./run-integrator.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures");
const node = process.execPath;

function sandbox(): string {
  return mkdtempSync(join(tmpdir(), "integrator-run-"));
}

function writeTree(root: string, files: Record<string, string>): void {
  mkdirSync(root, { recursive: true });
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

function copyPair(
  parentFiles: Record<string, string>,
  childFiles: Record<string, string>,
): { parent: string; child: string; root: string } {
  const root = sandbox();
  const parent = join(root, "parent");
  const child = join(root, "child");
  writeTree(parent, parentFiles);
  writeTree(child, childFiles);
  return { parent, child, root };
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

/** Inline fold: copies Child files onto Parent. No strategy package. */
const fakeCopyFold: FoldBackend = {
  async fold(input) {
    const stop = input.shouldStop();
    if (stop !== undefined) {
      return { ok: false, stop };
    }
    const walk = (from: string, to: string): void => {
      for (const name of readdirSync(from)) {
        if (name === ".git") {
          continue;
        }
        const src = join(from, name);
        const dest = join(to, name);
        if (statSync(src).isDirectory()) {
          mkdirSync(dest, { recursive: true });
          walk(src, dest);
        } else {
          copyFileSync(src, dest);
        }
      }
    };
    walk(input.child, input.parent);
    return { ok: true };
  },
};

describe("runIntegrator acceptance", () => {
  it("1. Child-only path is copied; Child unchanged", async () => {
    const { parent, child } = copyPair({ "keep.txt": "parent" }, { "new.txt": "from-child" });
    const result = await runIntegrator({
      backend: fakeCopyFold,
      invocation: baseInvocation({ parent, child }),
      write: () => {},
    });
    assert.equal(result.outcome, "integrated");
    assert.equal(result.exitCode, 0);
    assert.equal(result.parent, parent);
    assert.equal(readTree(parent, "new.txt"), "from-child");
    assert.equal(readTree(parent, "keep.txt"), "parent");
    assert.equal(readTree(child, "new.txt"), "from-child");
    assert.equal(existsSync(join(child, "keep.txt")), false);
  });

  it("2. Parent-only path stays; Child unchanged", async () => {
    const { parent, child } = copyPair(
      { "only-parent.txt": "stay", "shared.txt": "same" },
      { "shared.txt": "same" },
    );
    const result = await runIntegrator({
      backend: fakeCopyFold,
      invocation: baseInvocation({ parent, child }),
      write: () => {},
    });
    assert.equal(result.outcome, "integrated");
    assert.equal(readTree(parent, "only-parent.txt"), "stay");
    assert.equal(existsSync(join(child, "only-parent.txt")), false);
  });

  it("3. Same content on both; path unchanged on Parent; Child unchanged", async () => {
    const { parent, child } = copyPair({ "a.txt": "same" }, { "a.txt": "same" });
    const result = await runIntegrator({
      backend: fakeCopyFold,
      invocation: baseInvocation({ parent, child }),
      write: () => {},
    });
    assert.equal(result.outcome, "integrated");
    assert.equal(readTree(parent, "a.txt"), "same");
    assert.equal(readTree(child, "a.txt"), "same");
  });

  it("9. missing Child, missing Parent, relative path, empty id, nested paths → invalid-invocation", async () => {
    const { parseArgs } = await import("../args/parse-args.js");
    const { parent, child, root } = copyPair({ "a.txt": "p" }, { "b.txt": "c" });
    const strategy = ["--strategy", "@bluewombat/isolation-copy"] as const;

    const missingChild = parseArgs([
      "--id",
      "feat-1",
      "--parent",
      parent,
      "--child",
      join(root, "nope"),
      "--duration-ms",
      "1",
      ...strategy,
    ]);
    assert.equal(missingChild.ok, false);
    assert.equal(readTree(parent, "a.txt"), "p");

    const missingParent = parseArgs([
      "--id",
      "feat-1",
      "--parent",
      join(root, "nope-parent"),
      "--child",
      child,
      "--duration-ms",
      "1",
      ...strategy,
    ]);
    assert.equal(missingParent.ok, false);

    const relative = parseArgs([
      "--id",
      "feat-1",
      "--parent",
      "relative",
      "--child",
      child,
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
      child,
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

    const noStrategy = parseArgs([
      "--id",
      "feat-1",
      "--parent",
      parent,
      "--child",
      child,
      "--duration-ms",
      "1",
    ]);
    assert.equal(noStrategy.ok, false);
  });

  it("10. interrupt during the fold → interrupted; Parent restored; Child remains", async () => {
    const { parent, child } = copyPair({ "a.txt": "parent" }, { "b.txt": "child" });
    const flag = { interrupted: false };
    const wrappedWrite = (line: Record<string, unknown>): void => {
      if (line.event === "integration-started") {
        flag.interrupted = true;
      }
    };
    const result = await runIntegrator({
      backend: fakeCopyFold,
      invocation: baseInvocation({ parent, child }),
      write: wrappedWrite,
      interruptFlag: flag,
    });
    assert.equal(result.outcome, "interrupted");
    assert.equal(result.exitCode, 130);
    assert.equal(readTree(parent, "a.txt"), "parent");
    assert.equal(existsSync(join(parent, "b.txt")), false);
    assert.equal(readTree(child, "b.txt"), "child");
    assert.ok(existsSync(parent));
    assert.ok(existsSync(child));
  });

  it("11. Integration clock fires during the fold → failed; report names the clock", async () => {
    const { parent, child } = copyPair({ "a.txt": "parent" }, { "b.txt": "child" });
    let calls = 0;
    const result = await runIntegrator({
      backend: fakeCopyFold,
      invocation: baseInvocation({ parent, child, durationMs: 100 }),
      write: () => {},
      now: () => {
        const value = calls === 0 ? 0 : 10_000;
        calls += 1;
        return value;
      },
    });
    assert.equal(result.outcome, "failed");
    assert.equal(result.exitCode, 3);
    assert.equal(result.report, "The Integration clock fired.");
    assert.equal(readTree(parent, "a.txt"), "parent");
    assert.equal(existsSync(join(parent, "b.txt")), false);
    assert.equal(readTree(child, "b.txt"), "child");
  });

  it("12. never deletes Parent or Child; never writes its own working file into Child", async () => {
    const { parent, child } = copyPair({ "a.txt": "parent" }, { "b.txt": "child" });
    const beforeChild = readdirSync(child);
    const result = await runIntegrator({
      backend: fakeCopyFold,
      invocation: baseInvocation({ parent, child }),
      write: () => {},
    });
    assert.equal(result.outcome, "integrated");
    assert.ok(existsSync(parent));
    assert.ok(existsSync(child));
    assert.deepEqual(readdirSync(child).sort(), beforeChild.sort());
    assert.equal(existsSync(join(child, "integrator-own.txt")), false);
  });

  it("13. A directory that was Parent can be --child of a later Integration", async () => {
    const root = sandbox();
    const firstParent = join(root, "first-parent");
    const firstChild = join(root, "first-child");
    const secondParent = join(root, "second-parent");
    writeTree(firstParent, { "from-first.txt": "one" });
    writeTree(firstChild, { "from-child.txt": "two" });
    writeTree(secondParent, { "keep.txt": "stay" });
    const first = await runIntegrator({
      backend: fakeCopyFold,
      invocation: baseInvocation({ parent: firstParent, child: firstChild }),
      write: () => {},
    });
    assert.equal(first.outcome, "integrated");
    const second = await runIntegrator({
      backend: fakeCopyFold,
      invocation: baseInvocation({ id: "feat-2", parent: secondParent, child: firstParent }),
      write: () => {},
    });
    assert.equal(second.outcome, "integrated");
    assert.equal(readTree(secondParent, "from-first.txt"), "one");
    assert.equal(readTree(secondParent, "from-child.txt"), "two");
    assert.equal(readTree(secondParent, "keep.txt"), "stay");
  });

  it("14. integrating:feat-1 on stdout and via --on-status", async () => {
    const { parent, child, root } = copyPair({ "a.txt": "p" }, { "b.txt": "c" });
    const statusLog = join(root, "status.log");
    process.env.ON_STATUS_LOG = statusLog;
    try {
      const { write, lines } = collectLines();
      const result = await runIntegrator({
        backend: fakeCopyFold,
        invocation: baseInvocation({
          parent,
          child,
          onStatusArgv: [node, join(fixtures, "on-status-log.mjs")],
        }),
        write,
      });
      assert.equal(result.outcome, "integrated");
      assert.ok(lines.some((l) => l.event === "status" && l.label === "integrating:feat-1"));
      const logged = readFileSync(statusLog, "utf8");
      assert.ok(logged.includes("integrating:feat-1"));
    } finally {
      delete process.env.ON_STATUS_LOG;
    }
  });

  it("15. --on-status exiting non-zero does not change an integrated Integration", async () => {
    const { parent, child } = copyPair({ "a.txt": "p" }, { "b.txt": "c" });
    const result = await runIntegrator({
      backend: fakeCopyFold,
      invocation: baseInvocation({
        parent,
        child,
        onStatusArgv: [node, join(fixtures, "on-status-fail.mjs")],
      }),
      write: () => {},
    });
    assert.equal(result.outcome, "integrated");
    assert.equal(readTree(parent, "b.txt"), "c");
  });

  it("stop signal racing the clock uses interrupted", async () => {
    const { parent, child } = copyPair({ "a.txt": "p" }, { "b.txt": "c" });
    const flag = { interrupted: true };
    let calls = 0;
    const result = await runIntegrator({
      backend: fakeCopyFold,
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
    assert.equal(readTree(parent, "a.txt"), "p");
    assert.ok(existsSync(child));
  });
});
