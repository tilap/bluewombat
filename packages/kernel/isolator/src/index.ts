/**
 * Import entry point for this Transformer.
 *
 * The Transformer is a function. `cli.ts` is a thin adapter over this surface: it
 * reads argv and stdin, calls runIsolator, and maps the outcome to an exit code.
 * Everything a caller needs in process is reachable from here.
 *
 * Isolation strategies (git, copy, …) live under `packages/plugins/isolation-*`.
 */

export type { IsolationBackend } from "./isolate/backend.js";
export type { IsolationStop } from "./isolate/stop.js";
export { IsolationStoppedError, throwIfStopped } from "./isolate/stop.js";
export type { ProgressWriter } from "./progress/emit.js";
export type { RunOptions, RunResult } from "./run/run-isolator.js";
export { runIsolator } from "./run/run-isolator.js";
export type * from "./types.js";
