/**
 * The plugins Host ships with, by name — the one place these names are
 * written. Host's code never imports a plugin; it loads one by the name a
 * config gives, and these are the names `mason init` writes and `persist`
 * falls back to. Host's package.json declares exactly these, so a config
 * `init` wrote runs with nothing else installed. A manager has no default:
 * Host cannot pick a tracker.
 */

/** Isolation by git worktree, for a work line that is a git tree. */
export const ISOLATION_GIT = "@bluewombat/isolation-git";
/** Isolation by directory copy, for a plain directory. */
export const ISOLATION_COPY = "@bluewombat/isolation-copy";
/** Where the ledger goes when a config says nothing: one JSON file per key. */
export const DEFAULT_PERSIST = "@bluewombat/persist-fs";
/** The Planner `init` points a new config at until the Project writes its own. */
export const BOOTSTRAP_PLANNER = "@bluewombat/slots/planners/one-subtask.mjs";
