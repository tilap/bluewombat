/**
 * Import entry point for this Transformer.
 *
 * The Transformer is a function. `cli.ts` is a thin adapter over this surface: it
 * reads argv and stdin, calls runIntegrator, and maps the outcome to an exit code.
 * Everything a caller needs in process is reachable from here.
 *
 * Isolation strategies (git, copy, …) live under `packages/plugins/isolation-*`.
 */

export type { FoldBackend } from "./fold/backend.js";
export type { FoldStop } from "./fold/working-files.js";
export { IntegrationStoppedError, throwIfStopped } from "./fold/working-files.js";
export type { ProgressWriter } from "./progress/emit.js";
export type { RunOptions, RunResult } from "./run/run-integrator.js";
export { runIntegrator } from "./run/run-integrator.js";
export type * from "./types.js";
