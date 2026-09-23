#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  emitPublication,
  emitPublishRefusal,
  ownArgv,
  PUBLISHER_FLAGS,
  take,
  writeDiagnostic,
} from "@bluewombat/slot-kit";

// Put the feature's work where the Authority can read it, by pushing the name
// Isolator gave it to the work line's own remote.
//
// A plain push, and no force of any kind. Integrator only ever adds history, so
// republishing after a refusal is a fast-forward of what was already there. A
// rejection therefore means the name moved under us — someone else's commit, or
// a rewrite — and that is exactly the case worth refusing rather than
// overwriting.
//
// The remote is `origin`, and there is no option for it: Host reads the work
// line back from `origin` after the Authority folds, with no way to learn what
// this slot was told. An option that publishes to one remote while the refresh
// reads another is a trap, so it waits for that half to become a slot too.
//
// Runs in the work line. mason appends --id, --ref and --target.

const cwd = process.cwd();
const tokens = ownArgv(process.argv, PUBLISHER_FLAGS);
if (tokens.length > 0) {
  emitPublishRefusal(`git publisher takes no option, got "${tokens[0]}".`);
  process.exit(0);
}
const remote = "origin";

const ref = take(process.argv, "--ref");
if (ref === undefined || ref.trim().length === 0) {
  emitPublishRefusal("git publisher was given no --ref to publish.");
  process.exit(0);
}

if (!existsSync(join(cwd, ".git"))) {
  emitPublishRefusal("A Submission needs a git work line; this one has no .git.");
  process.exit(0);
}

const pushed = spawnSync("git", ["-C", cwd, "push", remote, `${ref}:${ref}`], {
  encoding: "utf8",
});
if (pushed.error !== undefined) {
  writeDiagnostic(`git publisher cannot run git: ${pushed.error.message}\n`);
  process.exit(1);
}
if (pushed.status !== 0) {
  const detail = `${pushed.stderr ?? ""}${pushed.stdout ?? ""}`.trim().slice(-1000);
  emitPublishRefusal(`Could not publish ${ref}: ${detail}`);
  process.exit(0);
}

emitPublication(ref);
