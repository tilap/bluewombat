import type { BreakDownResult, ImplementResult, TransformerPort } from "@bluewombat/conductor";
import { runBreakdown } from "@bluewombat/feature-breakdown";
import {
  type GateSpec,
  type Trace as ImplementerTrace,
  runImplementer,
} from "@bluewombat/implementer";
import { type FoldBackend, runIntegrator } from "@bluewombat/integrator";
import { type IsolationBackend, runIsolator } from "@bluewombat/isolator";
import type { AssemblySpec, GatedPassSpec, StageSpec } from "../config/types.js";
import type { Journal } from "./journal.js";
import type { Streams } from "./streams.js";
import { failureNote, type Trace } from "./trace.js";

export type TransformerSlots = {
  /** Where the Transformers say what they are doing. Absent: nowhere. */
  trace?: Trace;
  /** Film of every progress line, including ones the Trace drops. Absent: nowhere. */
  journal?: Journal;
  /**
   * Where a child's raw output is filmed as it arrives. Absent — the default —
   * nothing is filmed and a child's output leaves a Transformer as one word.
   */
  streams?: Streams;
  /** FeatureStandard in, a Plan out. Gated: judges `workLineStable` once a Plan is accepted. */
  planner: GatedPassSpec;
  /** Making a Subtask, and the Gates judging what came out of it. */
  builder: StageSpec;
  /** Judging the assembled feature, and the command that fixes a refusal. */
  assembly: AssemblySpec;
  /**
   * The persistent trunk a planner Gate checks — not an ephemeral per-Task
   * workspace, and not where the Planner agent itself reads from (that stays
   * the Project's own `--read` convention; see feature-breakdown SPECS.md §5a).
   */
  workLineStable: string;
  /** How Isolator produces the Child. Host chooses; Isolator does not sniff. */
  isolation: IsolationBackend;
  /** How Integrator folds. Must match `isolation`. */
  fold: FoldBackend;
  /** How long any one child outside a Task may run: manager, isolations. */
  timeoutMs: number;
  /**
   * Host's own interrupt flag, flipped by SIGINT / SIGTERM. A Transformer owns
   * no signal handler, so without this an interrupt waits for the child at
   * work — an agent, minutes — to end on its own. Absent: never interrupted.
   */
  interruptFlag?: { interrupted: boolean };
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
 * Only the lines that name a phase or an outcome are kept. A line that
 * records why a stop happened — the child's last words — is printed too.
 * The rest is bookkeeping nobody watches.
 */
function progressTrace(trace: Trace | undefined): (line: Record<string, unknown>) => void {
  if (trace === undefined) {
    return silent;
  }
  return (line) => {
    if (typeof line.label === "string") {
      const id = typeof line.id === "string" ? line.id : String(line.task_id ?? "");
      const label = id.length > 0 ? line.label.replace(`:${id}`, "") : line.label;
      trace(id.length > 0 ? `  ${id}  ${label}` : `  ${label}`);
    }
    const note = failureNote(line);
    if (note.length > 0) {
      trace(`  ${note}`);
    }
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
 * How long the agent of this pass may run.
 *
 * A Subtask names its producer. An assembly names a fix, and only when something
 * already refused the whole — or, before that, a validate.
 */
function commandTimeoutMs(
  input: { stage?: string; validate?: boolean },
  slots: TransformerSlots,
): number {
  if (input.validate === true) {
    return slots.assembly.validate?.timeoutMs ?? slots.timeoutMs;
  }
  if (input.stage === "assembly") {
    return slots.assembly.fix?.timeoutMs ?? slots.timeoutMs;
  }
  return slots.builder.producer.timeoutMs;
}

function attemptBudget(
  input: { stage?: string; produce?: boolean; validate?: boolean },
  slots: TransformerSlots,
): number {
  if (input.produce === false || input.validate === true) {
    return 1;
  }
  const stage = input.stage === "assembly" ? slots.assembly : slots.builder;
  return stage.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
}

type RoleWiring = {
  builderArgv?: string[];
  repairArgv?: string[];
  repairTimeoutMs?: number;
  gates: GateSpec[];
  /** Judges the Attempt that ran `repairArgv`, when present. Ignored otherwise. */
  repairGates: GateSpec[];
};

/**
 * Which command runs, and which Gate sequence judges it — decided together,
 * so the two can never fall out of sync (see DECISIONS.md: every role gated
 * independently, no shared list, no dispatch choosing between two buckets).
 */
function roleWiring(
  input: { stage?: string; produce?: boolean; validate?: boolean },
  slots: TransformerSlots,
): RoleWiring {
  if (input.validate === true) {
    const validate = slots.assembly.validate;
    return validate === undefined
      ? { gates: [], repairGates: [] }
      : { builderArgv: validate.cmd, gates: validate.gates, repairGates: [] };
  }
  if (input.produce === false) {
    // The one remaining judgement-only pass: re-checking the assembled
    // feature with no producer of its own. No named role maps to it; it is
    // judged by `assembly.gates`, its own sequence, untouched by any of the
    // five roles' own lists (see AssemblySpec's doc comment).
    return { gates: slots.assembly.gates, repairGates: [] };
  }
  if (input.stage === "assembly") {
    const fix = slots.assembly.fix;
    if (fix === undefined) {
      return { gates: [], repairGates: [] };
    }
    // Implementer picks repairArgv only when a report is present, and Conductor
    // never produces at assembly without one. The fix command is the producer.
    return { builderArgv: fix.cmd, gates: fix.gates, repairGates: [] };
  }
  const { producer, repair } = slots.builder;
  return {
    builderArgv: producer.cmd,
    repairArgv: repair.cmd,
    repairTimeoutMs: repair.timeoutMs,
    gates: producer.gates,
    repairGates: repair.gates,
  };
}

export function createTransformers(slots: TransformerSlots): TransformerPort {
  const write = progressWriter(slots);
  const streams = slots.streams;
  const interrupt = slots.interruptFlag === undefined ? {} : { interruptFlag: slots.interruptFlag };
  return {
    async isolate(input) {
      const result = await runIsolator({
        invocation: {
          id: input.id,
          parent: input.parent,
          child: input.child,
          durationMs: input.durationMs,
          ...(input.context === undefined ? {} : { context: input.context }),
        },
        backend: slots.isolation,
        write,
        ...interrupt,
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
          // Not where the Planner agent itself reads from (that is the
          // Project's own --read convention, untouched) — only where a
          // planner Gate looks, once a Plan is otherwise accepted.
          workspace: slots.workLineStable,
          gates: slots.planner.gates,
        },
        featureJson: input.featureJson,
        write,
        ...interrupt,
        // `breakdown` is the name a Planner slot files its transcript under, so
        // the stream and the prompt behind it land side by side.
        ...(streams === undefined
          ? {}
          : { onChild: (about) => streams.open({ key: about.key, id: "breakdown" }) }),
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
      const wiring = roleWiring(input, slots);
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
          ...(wiring.builderArgv === undefined ? {} : { builderArgv: wiring.builderArgv }),
          ...(wiring.repairArgv === undefined ? {} : { repairArgv: wiring.repairArgv }),
          ...(wiring.repairTimeoutMs === undefined
            ? {}
            : { repairTimeoutMs: wiring.repairTimeoutMs }),
          gates: wiring.gates,
          repairGates: wiring.repairGates,
          // A pass that makes nothing cannot make a different result on a second
          // try: whoever asked for the judgement owns the retrying.
          maxAttempts: attemptBudget(input, slots),
          builderTimeoutMs: commandTimeoutMs(input, slots),
        },
        write,
        ...interrupt,
        ...(streams === undefined
          ? {}
          : {
              onChild: (about) =>
                streams.open({
                  key: about.key,
                  id: about.task_id,
                  attempt: about.attempt,
                  gateId: about.gate_id,
                }),
            }),
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
          ...(input.context === undefined ? {} : { context: input.context }),
          ...(input.subject === undefined ? {} : { subject: input.subject }),
          ...(input.mergeSubject === undefined ? {} : { mergeSubject: input.mergeSubject }),
        },
        backend: slots.fold,
        write,
        ...interrupt,
      });
      return { outcome: result.outcome };
    },
  };
}
