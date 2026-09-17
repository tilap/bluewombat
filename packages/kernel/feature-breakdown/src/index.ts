/**
 * Import entry point for this Transformer.
 *
 * The Transformer is a function. `cli.ts` is a thin adapter over this surface: it
 * reads argv and stdin, calls runBreakdown, and maps the outcome to an exit code.
 * Everything a caller needs in process is reachable from here.
 */

export type { ProgressWriter } from "./progress/emit.js";
export type { RunOptions, RunResult } from "./run/run-breakdown.js";
export { runBreakdown } from "./run/run-breakdown.js";
export type * from "./types.js";
