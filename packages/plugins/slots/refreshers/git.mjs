#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  emitRefreshed,
  emitRefreshRefusal,
  ownArgv,
  REFRESHER_FLAGS,
  take,
} from "@bluewombat/slot-kit";

// Bring the work line copy up to what the Authority holds.
//
// An accepted Submission moved the reference work line. A copy left behind
// would make the next Isolation start from a version that no longer exists, so
// this runs before anything else in a pass.
//
// Fast-forward only: this system never rewrites that line. A copy that cannot
// fast-forward has been written to by somebody else, and that is a person's
// problem, not a merge to attempt.
//
// The remote is `origin`, like the git Publisher's. Takes no option.

const cwd = process.cwd();
const tokens = ownArgv(process.argv, REFRESHER_FLAGS);
if (tokens.length > 0) {
  emitRefreshRefusal(`git refresher takes no option, got "${tokens[0]}".`);
  process.exit(0);
}

const target = take(process.argv, "--target");
if (target === undefined || target.trim().length === 0) {
  emitRefreshRefusal("git refresher was given no --target work line.");
  process.exit(0);
}

// A plain directory has no reference held anywhere else: it is the work line.
if (!existsSync(join(cwd, ".git"))) {
  emitRefreshed();
  process.exit(0);
}

const fetched = git(["fetch", "origin", target]);
if (fetched.status !== 0) {
  emitRefreshRefusal(
    `Cannot fetch origin/${target} from ${cwd}: ${fetched.stderr.trim().slice(-500)}`,
  );
  process.exit(0);
}

const merged = git(["merge", "--ff-only", `origin/${target}`]);
if (merged.status !== 0) {
  // The one way a copy stops fast-forwarding is a commit made into it that
  // the reference does not have. The copy is the system's, not a person's:
  // nothing in it is worth keeping, and the reader needs the way out more
  // than git's own words.
  emitRefreshRefusal(
    [
      `${cwd} has diverged from origin/${target}: it holds commits the reference does not.`,
      "Nothing in this copy is worth keeping — it is the system's, refetched at every start.",
      `Put it back with: git -C ${cwd} reset --hard origin/${target}`,
      "or delete the directory and start again; it is fetched afresh.",
      `git said: ${merged.stderr.trim().slice(-300)}`,
    ].join("\n"),
  );
  process.exit(0);
}

emitRefreshed();

/**
 * C locale, as in the Publisher: what git says here ends up in a report.
 * @param {string[]} args
 */
function git(args) {
  return spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  });
}
