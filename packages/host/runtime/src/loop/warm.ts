import type { WarmOutcome, WarmPort } from "@bluewombat/conductor";
import type { PassSpec } from "../config/types.js";
import type { Journal } from "./journal.js";
import { runSlot } from "./run-slot.js";
import type { Trace } from "./trace.js";

/**
 * Run the Project's Feature warm command in a Feature workspace.
 *
 * Isolation leaves a cold tree (no `node_modules`); Subtasks copy that tree.
 * Warming the Feature once means every Subtask inherits the install.
 */
export function openWarm(input: {
  pass: PassSpec;
  interruptFlag?: { interrupted: boolean };
  trace?: Trace;
  journal?: Journal;
}): WarmPort & { durationMs: number } {
  return {
    durationMs: input.pass.timeoutMs,
    async prepare({ workspace, durationMs }) {
      const flag = input.interruptFlag;
      if (flag?.interrupted === true) {
        return { outcome: "interrupted" };
      }
      const [command, ...args] = input.pass.cmd;
      if (command === undefined) {
        return { outcome: "invalid-invocation" };
      }
      input.journal?.append({ event: "warm", phase: "start", workspace });
      input.trace?.(`warm       ${workspace}`);
      const run = await runSlot({
        command,
        args,
        cwd: workspace,
        timeoutMs: durationMs,
      });
      if (flag !== undefined && flag.interrupted) {
        return { outcome: "interrupted" };
      }
      if (run.error !== undefined) {
        input.journal?.append({
          event: "warm",
          outcome: "failed",
          detail: run.error.message,
        });
        input.trace?.(`warm       failed: ${run.error.message}`);
        return { outcome: "failed" satisfies WarmOutcome };
      }
      if (run.status !== 0) {
        const detail = (run.stderr.trim() || run.stdout.trim()).slice(-500);
        input.journal?.append({
          event: "warm",
          outcome: "failed",
          status: run.status,
          ...(detail.length > 0 ? { detail } : {}),
        });
        input.trace?.(
          detail.length > 0
            ? `warm       failed (exit ${run.status}): ${detail}`
            : `warm       failed (exit ${run.status})`,
        );
        return { outcome: "failed" };
      }
      input.journal?.append({ event: "warm", outcome: "warmed" });
      input.trace?.("warm       warmed");
      return { outcome: "warmed" };
    },
  };
}
