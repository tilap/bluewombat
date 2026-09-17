import type { BreakDownResult, ImplementResult, TransformerPort } from "@bluewombat/conductor";
import { runBreakdown } from "@bluewombat/feature-breakdown";
import {
  type GateSpec,
  type Trace as ImplementerTrace,
  runImplementer,
} from "@bluewombat/implementer";
import { type FoldBackend, runIntegrator } from "@bluewombat/integrator";
import { type IsolationBackend, runIsolator } from "@bluewombat/isolator";
import type { AssemblySpec, PassSpec, StageSpec } from "../config/types.js";
import type { Journal } from "./journal.js";
import type { Trace } from "./trace.js";

export type TransformerSlots = {
  /** Where the Transformers say what they are doing. Absent: nowhere. */
  trace?: Trace;
  /** Film of every progress line, including ones the Trace drops. Absent: nowhere. */
  journal?: Journal;
  planner: PassSpec;
  /** Making a Subtask, and the Gates judging what came out of it. */
  builder: StageSpec;
  /** Judging the assembled feature, and the command that fixes a refusal. */
  assembly: AssemblySpec;
  /** How Isolator produces the Child. Host chooses; Isolator does not sniff. */
  isolation: IsolationBackend;
  /** How Integrator folds. Must match `isolation`. */
  fold: FoldBackend;
  /** How long any one child outside a Task may run: manager, isolations. */
  timeoutMs: number;
  maxUnits: number;
  maxFeatureBytes: number;
};

const DEFAULT_MAX_ATTEMPTS = 3;

const silent = (): void => {};

/**
 * A Transformer's progress, as a line a person reads.
 *
 * Each of them already says what it is doing on its own writer; Host used to
 * drop all of it, which is why a run of several minutes said nothing at all.
 * Only the lines that name a phase or an outcome are kept — the rest is
 * bookkeeping nobody watches.
 */
function progressTrace(trace: Trace | undefined): (line: Record<string, unknown>) => void {
  if (trace === undefined) {
    return silent;
  }
  return (line) => {
    // Only the phase labels. Each Transformer also writes a closing line with
    // the outcome, and that outcome is already the last phase it announced.
    if (typeof line.label !== "string") {
      return;
    }
    const id = typeof line.id === "string" ? line.id : String(line.task_id ?? "");
    const label = id.length > 0 ? line.label.replace(`:${id}`, "") : line.label;
    trace(id.length > 0 ? `  ${id}  ${label}` : `  ${label}`);
  };
}

/**
 * The journal keeps every progress line; the Trace keeps the ones a person reads.
 */
function progressWriter(slots: TransformerSlots): (line: Record<string, unknown>) => void {
  const toTrace = progressTrace(slots.trace);
  const journal = slots.journal;
  return (line) => {
    journal?.append({ ...line });
    toTrace(line);
  };
}

/**
 * Wire the four execution Transformers into Conductor's Transformer Port.
 */
/**
 * Why an Attempt ended, when it did not end well.
 *
 * The first Gate that did not pass is the one that stopped the sequence, so its
 * report is the reason. With no such Gate, the producer is what failed, and the
 * detail it left is the reason.
 */
/**
 * What ended this Attempt, and what said so.
 *
 * The name matters as much as the words: a report handed on unattributed
 * reaches the next producer as "something refused this", and the Gate that
 * looked at the work is exactly what tells it where to look.
 */
function reasonOf(trace: ImplementerTrace): { report: string; from?: string } | undefined {
  const refused = trace.gates.find((gate) => gate.verdict !== "pass");
  if (refused !== undefined && refused.report.trim().length > 0) {
    return { report: refused.report, from: refused.id };
  }
  const detail = trace.builder.result.detail;
  return detail !== undefined && detail.trim().length > 0 ? { report: detail } : undefined;
}

/**
 * Which sequence judges this Task.
 *
 * `assembly.gates` judge what was published, so they belong to the pass that
 * judges — not to the one that makes, whose Gates would still be looking at what
 * was there before it published anything.
 *
 * A making pass is judged like any other making pass, by the Project's own
 * sequence. Leaving it ungated lets a producer that made nothing pass, republish
 * the same thing, and be refused again until the budget is gone.
 */
function gatesFor(
  input: { stage?: string; produce?: boolean },
  slots: TransformerSlots,
): GateSpec[] {
  return input.stage === "assembly" && input.produce === false
    ? slots.assembly.gates
    : slots.builder.gates;
}

/**
 * How long the agent of this pass may run.
 *
 * A Subtask names its producer. An assembly names a fix, and only when something
 * already refused the whole.
 */
function commandTimeoutMs(input: { stage?: string }, slots: TransformerSlots): number {
  if (input.stage === "assembly") {
    return slots.assembly.fix?.timeoutMs ?? slots.timeoutMs;
  }
  return slots.builder.producer.timeoutMs;
}

function attemptBudget(
  input: { stage?: string; produce?: boolean },
  slots: TransformerSlots,
): number {
  if (input.produce === false) {
    return 1;
  }
  const stage = input.stage === "assembly" ? slots.assembly : slots.builder;
  return stage.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
}

function producersFor(
  input: { stage?: string; produce?: boolean },
  slots: TransformerSlots,
):
  | {
      builderArgv: string[];
      repairArgv?: string[];
      repairTimeoutMs?: number;
    }
  | undefined {
  if (input.produce === false) {
    return undefined;
  }
  if (input.stage === "assembly") {
    const fix = slots.assembly.fix;
    if (fix === undefined) {
      return undefined;
    }
    // Implementer picks repairArgv only when a report is present, and Conductor
    // never produces at assembly without one. The fix command is the producer.
    return { builderArgv: fix.cmd };
  }
  const { producer, repair } = slots.builder;
  return {
    builderArgv: producer.cmd,
    repairArgv: repair.cmd,
    repairTimeoutMs: repair.timeoutMs,
  };
}

export function createTransformers(slots: TransformerSlots): TransformerPort {
  const write = progressWriter(slots);
  return {
    async isolate(input) {
      const result = await runIsolator({
        invocation: {
          id: input.id,
          parent: input.parent,
          child: input.child,
          durationMs: input.durationMs,
        },
        backend: slots.isolation,
        write,
      });
      return { outcome: result.outcome };
    },

    async breakDown(input): Promise<BreakDownResult> {
      const result = await runBreakdown({
        invocation: {
          maxFeatureBytes: slots.maxFeatureBytes,
          maxUnits: slots.maxUnits,
          plannerArgv: slots.planner.cmd,
          plannerDurationMs: slots.planner.timeoutMs,
        },
        featureJson: input.featureJson,
        write,
      });
      if (result.outcome === "planned" && result.plan !== undefined) {
        return {
          outcome: "planned",
          plannedAt: result.plan.planned_at,
          subtasks: result.plan.subtasks.map((st) => ({
            id: st.id,
            intention: st.intention,
            definition_of_done: st.definition_of_done,
            depends_on: [...st.depends_on],
          })),
        };
      }
      if (result.outcome === "refused") {
        return {
          outcome: "refused",
          code: result.code ?? "not-specifiable",
          reason: result.reason ?? "FeatureBreakdown refused the Plan.",
        };
      }
      if (result.outcome === "unavailable" || result.outcome === "interrupted") {
        return { outcome: result.outcome };
      }
      return { outcome: "invalid-invocation" };
    },

    async implement(input): Promise<ImplementResult> {
      const producers = producersFor(input, slots);
      const result = await runImplementer({
        invocation: {
          id: input.id,
          intention: input.intention,
          // Implementer always carries the flag and never reads it; an assembly
          // has nothing to put in it, and the roles drop an empty one whole.
          definitionOfDone: input.definitionOfDone ?? "",
          workspace: input.workspace,
          // Without this the report an outside judge sent back never reaches
          // the producer, and the Attempt repeats blind.
          ...(input.report === undefined ? {} : { report: input.report }),
          ...(input.reportFrom === undefined ? {} : { reportFrom: input.reportFrom }),
          ...(input.context === undefined ? {} : { context: input.context }),
          ...(input.stage === undefined ? {} : { stage: input.stage }),
          ...(producers === undefined ? {} : producers),
          gates: gatesFor(input, slots),
          // A pass that makes nothing cannot make a different result on a second
          // try: whoever asked for the judgement owns the retrying.
          maxAttempts: attemptBudget(input, slots),
          builderTimeoutMs: commandTimeoutMs(input, slots),
        },
        write,
      });
      return {
        outcome: result.outcome,
        traces: result.traces.map((trace) => {
          const reason = reasonOf(trace);
          if (reason === undefined) {
            return { ended: trace.ended };
          }
          return {
            ended: trace.ended,
            report: reason.report,
            ...(reason.from === undefined ? {} : { refusedBy: reason.from }),
          };
        }),
      };
    },

    async integrate(input) {
      const result = await runIntegrator({
        invocation: {
          id: input.id,
          parent: input.parent,
          child: input.child,
          durationMs: input.durationMs,
          ...(input.subject === undefined ? {} : { subject: input.subject }),
          ...(input.mergeSubject === undefined ? {} : { mergeSubject: input.mergeSubject }),
        },
        backend: slots.fold,
        write,
      });
      return { outcome: result.outcome };
    },
  };
}
