import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import type { FoldBackend } from "./backend.js";
import { fold } from "./fold.js";

function parentWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "integrator-fold-"));
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

function run(parent: string, backend: FoldBackend) {
  return fold({
    parent,
    child: parent,
    backend,
    deadlineMs: Date.now() + 30_000,
    now: Date.now,
    shouldInterrupt: () => false,
  });
}

/** Every file and symlink under `directory`, `node_modules/` at the root left out. */
function withoutNodeModules(directory: string, prefix = ""): string[] {
  return readdirSync(directory)
    .sort()
    .flatMap((name) => {
      const relative = prefix === "" ? name : `${prefix}/${name}`;
      if (relative === "node_modules") {
        return [];
      }
      const path = join(directory, name);
      return statSync(path, { throwIfNoEntry: false })?.isDirectory() === true
        ? withoutNodeModules(path, relative)
        : [relative];
    });
}

/** A backend that never writes under `node_modules/`, and says so. */
function ignoringNodeModules(parent: string, fold: FoldBackend["fold"]): FoldBackend {
  return { snapshotPaths: async () => withoutNodeModules(parent), fold };
}

/** What a fold that gives up leaves behind it: a changed file, a deleted one, a new one. */
function messUp(parent: string): void {
  writeFileSync(join(parent, "a.txt"), "changed by the fold");
  rmSync(join(parent, "src/b.txt"));
  writeFileSync(join(parent, "created.txt"), "made by the fold");
}

const GAVE_UP = { ok: false, detail: "gave up" } as const;

describe("fold: snapshotPaths", () => {
  it("restores the listed files and removes what the fold created", async () => {
    const parent = parentWith({ "a.txt": "a", "src/b.txt": "b", "node_modules/dep.js": "dep" });
    const result = await run(
      parent,
      ignoringNodeModules(parent, async () => {
        messUp(parent);
        return GAVE_UP;
      }),
    );
    assert.deepEqual(result, GAVE_UP);
    assert.equal(readFileSync(join(parent, "a.txt"), "utf8"), "a");
    assert.equal(readFileSync(join(parent, "src/b.txt"), "utf8"), "b");
    assert.equal(existsSync(join(parent, "created.txt")), false);
    assert.equal(readFileSync(join(parent, "node_modules/dep.js"), "utf8"), "dep");
  });

  it("does not read a file the backend leaves out", async () => {
    // Copying everything would fail on this unreadable file.
    const parent = parentWith({ "a.txt": "a", "src/b.txt": "b", "node_modules/locked.js": "x" });
    const locked = join(parent, "node_modules/locked.js");
    chmodSync(locked, 0o000);
    try {
      const result = await run(
        parent,
        ignoringNodeModules(parent, async () => {
          messUp(parent);
          return GAVE_UP;
        }),
      );
      assert.deepEqual(result, GAVE_UP);
      assert.equal(readFileSync(join(parent, "a.txt"), "utf8"), "a");
    } finally {
      chmodSync(locked, 0o644);
    }
  });

  it("does not roll back a file the backend left out: the list is the backend's promise", async () => {
    const parent = parentWith({ "a.txt": "a", "src/b.txt": "b", "node_modules/dep.js": "dep" });
    await run(
      parent,
      ignoringNodeModules(parent, async () => {
        messUp(parent);
        writeFileSync(join(parent, "node_modules/dep.js"), "written anyway");
        return GAVE_UP;
      }),
    );
    assert.equal(readFileSync(join(parent, "node_modules/dep.js"), "utf8"), "written anyway");
  });

  it("restores a symlink as a symlink", async () => {
    const parent = parentWith({ "a.txt": "a", "src/b.txt": "b" });
    symlinkSync("a.txt", join(parent, "link"));
    await run(
      parent,
      ignoringNodeModules(parent, async () => {
        messUp(parent);
        rmSync(join(parent, "link"));
        writeFileSync(join(parent, "link"), "now a file");
        return GAVE_UP;
      }),
    );
    assert.equal(lstatSync(join(parent, "link")).isSymbolicLink(), true);
    assert.equal(readlinkSync(join(parent, "link")), "a.txt");
  });

  it("copies everything when the backend cannot list the directory", async () => {
    const parent = parentWith({ "a.txt": "a", "src/b.txt": "b", "node_modules/dep.js": "dep" });
    await run(parent, {
      snapshotPaths: async () => undefined,
      async fold() {
        messUp(parent);
        rmSync(join(parent, "node_modules"), { recursive: true });
        return GAVE_UP;
      },
    });
    assert.equal(readFileSync(join(parent, "a.txt"), "utf8"), "a");
    assert.equal(readFileSync(join(parent, "node_modules/dep.js"), "utf8"), "dep");
  });

  it("copies everything when the backend has no snapshotPaths", async () => {
    const parent = parentWith({ "a.txt": "a", "src/b.txt": "b", "node_modules/dep.js": "dep" });
    await run(parent, {
      async fold() {
        messUp(parent);
        rmSync(join(parent, "node_modules"), { recursive: true });
        return GAVE_UP;
      },
    });
    assert.equal(readFileSync(join(parent, "a.txt"), "utf8"), "a");
    assert.equal(readFileSync(join(parent, "node_modules/dep.js"), "utf8"), "dep");
  });

  it("keeps the fold's result when it completes", async () => {
    const parent = parentWith({ "a.txt": "a", "src/b.txt": "b", "node_modules/dep.js": "dep" });
    const result = await run(
      parent,
      ignoringNodeModules(parent, async () => {
        writeFileSync(join(parent, "a.txt"), "folded");
        return { ok: true };
      }),
    );
    assert.deepEqual(result, { ok: true });
    assert.equal(readFileSync(join(parent, "a.txt"), "utf8"), "folded");
    assert.equal(readFileSync(join(parent, "node_modules/dep.js"), "utf8"), "dep");
  });
});
