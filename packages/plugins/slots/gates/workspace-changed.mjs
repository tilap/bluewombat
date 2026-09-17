#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { emitVerdict, GATE_FLAGS, ownArgv, stageOf } from "@bluewombat/slot-kit";

// An Attempt that changed nothing did not build anything.
// Work belongs in the working tree: a commit hides it from this Gate and from
// the Gates that judge the workspace against HEAD. No option.
//
// A unit of work only. An assembly is made of work already validated on its own,
// so there is a real case where the right thing to do is nothing, and refusing
// it does not send the producer back to work — it sends it back to find
// something to change. It obliges: the second attempt edits for the sake of
// editing. A Gate that cannot tell those apart must not be the one to decide.

const cwd = process.cwd();
const tokens = ownArgv(process.argv, GATE_FLAGS);

if (tokens.length > 0) {
  emitVerdict("fail-blocking", `workspace-changed takes no option, got "${tokens[0]}".`);
  process.exit(0);
}

if (git(["rev-parse", "--is-inside-work-tree"]).stdout.trim() !== "true") {
  emitVerdict("fail-blocking", "workspace-changed needs a git workspace.");
  process.exit(0);
}

if (stageOf(process.argv) === "assembly") {
  emitVerdict("pass");
  process.exit(0);
}

const status = git(["status", "--porcelain", "-uall"]);
if (status.status !== 0) {
  emitVerdict("fail-blocking", `workspace-changed cannot read git status: ${status.stderr.trim()}`);
  process.exit(0);
}

if (status.stdout.trim().length === 0) {
  emitVerdict(
    "fail-retryable",
    [
      "Nothing changed in this directory: this run produced nothing.",
      "Write the work into the working tree here, and do not commit it —",
      "a commit hides it from the checks that follow.",
    ].join(" "),
  );
  process.exit(0);
}

emitVerdict("pass");

/** @param {string[]} args */
function git(args) {
  return spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}
