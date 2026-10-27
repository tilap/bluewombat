#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { emitVerdict, GATE_FLAGS, ownArgv, pathMatchesGlob } from "@bluewombat/slot-kit";

// Fail-retryable when the workspace changed a path that matches none of the globs: the one place
// the workspace may be written is what the globs name (the tests and their manifest). The other
// side of `sensitive-path`, which names what may not be touched; a Project whose tests sit among its
// code (`**/*.test.ts` in every package) cannot say "everything but" with globs that only deny.
// Remaining argv after Implementer's flags are the globs.
//
// What counts is what a fold can carry: tracked paths that differ from HEAD (added, modified,
// deleted, renamed) and new paths .gitignore does not exclude.

const cwd = process.cwd();
const globs = ownArgv(process.argv, GATE_FLAGS).filter((token) => token.length > 0);

if (globs.length === 0) {
  emitVerdict("fail-blocking", "tests-only needs at least one glob.");
  process.exit(0);
}

const status = spawnSync(
  "git",
  ["-C", cwd, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
  {
    encoding: "utf8",
  },
);
if (status.status !== 0) {
  emitVerdict("fail-blocking", `tests-only needs a git workspace: ${status.stderr.trim()}`);
  process.exit(0);
}

/** @type {Set<string>} */
const changed = new Set();
const fields = status.stdout.split("\0");
for (let i = 0; i < fields.length; i++) {
  const entry = fields[i] ?? "";
  if (entry.length < 4) {
    continue;
  }
  changed.add(entry.slice(3));
  // A rename or a copy carries the old path in the next field.
  if (entry[0] === "R" || entry[0] === "C") {
    const old = fields[++i];
    if (old !== undefined && old.length > 0) {
      changed.add(old);
    }
  }
}

const outside = [...changed]
  .map((path) => path.replaceAll("\\", "/"))
  .filter((path) => !globs.some((glob) => pathMatchesGlob(path, glob)))
  .sort();

if (outside.length > 0) {
  emitVerdict(
    "fail-retryable",
    `Paths changed that are not tests or their manifest (${globs.join(", ")}):\n${outside.join("\n")}`,
  );
  process.exit(0);
}

emitVerdict("pass");
