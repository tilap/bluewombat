import type { ImplementResult, TransformerPort } from "@bluewombat/conductor";
import {
  type GateSpec,
  type Trace as ImplementerTrace,
  runImplementer,
} from "@bluewombat/implementer";
import { type FoldBackend, runIntegrator } from "@bluewombat/integrator";
import { type IsolationBackend, runIsolator } from "@bluewombat/isolator";
import {
  type FeatureSpec,
  type HostGateSpec,
  hasAgent,
  type ReviewSpec,
  type StageSpec,
  type TicketSpec,
} from "../config/types.js";
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
  /** Making the unit of work, and the Gates judging what came out of it. */
  builder: StageSpec;
  /** Judging the assembled ticket, and the command that fixes a refusal. */
  ticket: TicketSpec;
  /** Judging the whole Feature, and its own fix. Present whenever there is an Authority to fold it. */
  feature?: FeatureSpec;
  /** How Isolator produces the Child. Host chooses; Isolator does not sniff. */
  isolation: IsolationBackend;
  /** How Integrator folds. Must match `isolation`. */
  fold: FoldBackend;
  /**
   * What the tracker says of the piece of work a pass is about, read when the pass starts: a
   * label can move while a Feature is made. Absent: nothing is marked.
   */
  marks?: Marks;
  /** How long any one child outside a Task may run: manager, isolations. */
  timeoutMs: number;
  /**
   * Host's own interrupt flag, flipped by SIGINT / SIGTERM. A Transformer owns
   * no signal handler, so without this an interrupt waits for the child at
   * work — an agent, minutes — to end on its own. Absent: never interrupted.
   */
  interruptFlag?: { interrupted: boolean };
};

/** What a Task's key says of the work behind it, as the tracker last said it. */
export type Marks = {
  /** The key is a Ticket that holds the feature tests of its Feature. */
  ticketIsFeatureTest(key: string): Promise<boolean>;
  /** The key is a Feature that is not put through the feature-test acceptance check. */
  featureSkipsFeatureTest(key: string): Promise<boolean>;
};

type Marked = { featureTest: boolean; skipsFeatureTest: boolean };

const DEFAULT_MAX_ATTEMPTS = 3;

/** The Feature's config; a Feature is only judged when an Authority exists, and Host refuses to open without it. */
function featureOf(slots: TransformerSlots): FeatureSpec {
  if (slots.feature === undefined) {
    throw new Error('A Feature was judged, but no "feature" is configured.');
  }
  return slots.feature;
}

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
 * Wire the three execution Transformers into Conductor's Transformer Port.
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
 * The unit names its producer. A Ticket or a Feature names a fix, and only when
 * something already refused the whole — or, for a Ticket, before that, a validate.
 */
function commandTimeoutMs(
  input: { stage?: string; validate?: boolean },
  slots: TransformerSlots,
  marked: Marked,
): number {
  if (input.stage === "feature") {
    const feature = featureOf(slots);
    if (input.validate === true) {
      return hasAgent(feature.validate) ? feature.validate.timeoutMs : slots.timeoutMs;
    }
    return feature.fix.timeoutMs;
  }
  if (input.validate === true) {
    const validate = slots.ticket.validate;
    return validate !== undefined && hasAgent(validate) ? validate.timeoutMs : slots.timeoutMs;
  }
  if (input.stage === "ticket") {
    return slots.ticket.fix?.timeoutMs ?? slots.timeoutMs;
  }
  return marked.featureTest && slots.builder.featureTest !== undefined
    ? slots.builder.featureTest.timeoutMs
    : slots.builder.producer.timeoutMs;
}

function attemptBudget(
  input: { stage?: string; produce?: boolean; validate?: boolean },
  slots: TransformerSlots,
): number {
  if (input.produce === false || input.validate === true) {
    return 1;
  }
  if (input.stage === "feature") {
    return featureOf(slots).maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }
  const stage = input.stage === "ticket" ? slots.ticket : slots.builder;
  return stage.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
}

type RoleWiring = {
  builderArgv?: string[];
  repairArgv?: string[];
  repairTimeoutMs?: number;
  gates: GateSpec[];
  /** Judges the Attempt that ran `repairArgv`, when present. Ignored otherwise. */
  repairGates: GateSpec[];
  /** Gates Host did not run for this Feature, with the condition that left them out. */
  skipped?: { id: string; why: string }[];
};

/**
 * Implementer's Gates from the config's: the condition Host reads is Host's, and the Gate
 * knows nothing of it. A Feature's Gate whose condition holds is left out, and said so.
 */
function gatesFor(
  gates: readonly HostGateSpec[],
  marked: Marked,
): { gates: GateSpec[]; skipped: { id: string; why: string }[] } {
  const kept: GateSpec[] = [];
  const skipped: { id: string; why: string }[] = [];
  for (const { skipWhen, ...gate } of gates) {
    if (skipWhen === "skip-feature-test" && marked.skipsFeatureTest) {
      skipped.push({ id: gate.id, why: skipWhen });
    } else {
      kept.push(gate);
    }
  }
  return { gates: kept, skipped };
}

/** A review runs its agent and then its Gates; with no agent, the Gates alone. */
function reviewWiring(review: ReviewSpec): RoleWiring {
  return hasAgent(review)
    ? { builderArgv: review.cmd, gates: review.gates, repairGates: [] }
    : { gates: review.gates, repairGates: [] };
}

/**
 * Which command runs, and which Gate sequence judges it — decided together,
 * so the two can never fall out of sync (see DECISIONS.md: every role gated
 * independently, no shared list, no dispatch choosing between two buckets).
 */
function roleWiring(
  input: {
    stage?: string;
    produce?: boolean;
    validate?: boolean;
    recheck?: boolean;
  },
  slots: TransformerSlots,
  marked: Marked,
): RoleWiring {
  if (input.stage === "feature") {
    // The Feature's own sequences and its own fix, and nothing of a Ticket's.
    const feature = featureOf(slots);
    if (input.validate === true) {
      const wiring = reviewWiring(feature.validate);
      const own = gatesFor(feature.validate.gates, marked);
      return { ...wiring, gates: own.gates, skipped: own.skipped };
    }
    if (input.produce === false) {
      const own = gatesFor(feature.gates, marked);
      return { gates: own.gates, repairGates: [], skipped: own.skipped };
    }
    const own = gatesFor(feature.fix.gates, marked);
    return {
      builderArgv: feature.fix.cmd,
      gates: own.gates,
      repairGates: [],
      skipped: own.skipped,
    };
  }
  if (input.validate === true) {
    const validate = slots.ticket.validate;
    return validate === undefined ? { gates: [], repairGates: [] } : reviewWiring(validate);
  }
  if (input.recheck === true) {
    // The unit's own checks again, once the work has been aligned with the line:
    // `builder.gates`, the one list that says the code stands. Nothing is produced. The feature-test
    // Ticket's own Gates, when it is that Ticket.
    const own = marked.featureTest ? slots.builder.featureTest : undefined;
    return { gates: (own ?? slots.builder.producer).gates, repairGates: [] };
  }
  if (input.produce === false) {
    // The one remaining judgement-only pass: re-checking the assembled
    // ticket with no producer of its own. No named role maps to it; it is
    // judged by `ticket.gates`, its own sequence, untouched by any of the
    // roles' own lists (see TicketSpec's doc comment).
    return { gates: slots.ticket.gates, repairGates: [] };
  }
  if (input.stage === "ticket") {
    const fix = slots.ticket.fix;
    if (fix === undefined) {
      return { gates: [], repairGates: [] };
    }
    // Implementer picks repairArgv only when a report is present, and Conductor
    // never produces for a ticket without one. The fix command is the producer.
    return { builderArgv: fix.cmd, gates: fix.gates, repairGates: [] };
  }
  if (marked.featureTest && slots.builder.featureTest !== undefined) {
    // One command and one list for the first pass and for a repair: nothing of the shared
    // builder is borrowed, so no refusal reaches an agent the Project did not name for it.
    const { cmd, gates } = slots.builder.featureTest;
    return { builderArgv: cmd, gates, repairGates: gates };
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

/** What the tracker says of the work this pass is about, read once as the pass starts. */
async function markedBy(
  input: { stage?: string; context?: string },
  slots: TransformerSlots,
): Promise<Marked> {
  const key = input.context;
  if (slots.marks === undefined || key === undefined) {
    return { featureTest: false, skipsFeatureTest: false };
  }
  if (input.stage === "feature") {
    return { featureTest: false, skipsFeatureTest: await slots.marks.featureSkipsFeatureTest(key) };
  }
  if (input.stage === undefined || input.stage === "unit") {
    return { featureTest: await slots.marks.ticketIsFeatureTest(key), skipsFeatureTest: false };
  }
  return { featureTest: false, skipsFeatureTest: false };
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

    async implement(input): Promise<ImplementResult> {
      const marked = await markedBy(input, slots);
      const wiring = roleWiring(input, slots, marked);
      for (const gate of wiring.skipped ?? []) {
        // A Gate that was not run is not one that passed: the film and the trace say so.
        write({
          event: "gate-skipped",
          task_id: input.id,
          gate_id: gate.id,
          why: gate.why,
          label: `${gate.id} not run: the Feature carries ${gate.why}`,
        });
      }
      const result = await runImplementer({
        invocation: {
          id: input.id,
          intention: input.intention,
          workspace: input.workspace,
          // Without this the report an outside judge sent back never reaches
          // the producer, and the Attempt repeats blind.
          ...(input.report === undefined ? {} : { report: input.report }),
          ...(input.reportFrom === undefined ? {} : { reportFrom: input.reportFrom }),
          ...(input.firstAttempt === undefined ? {} : { firstAttempt: input.firstAttempt }),
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
          builderTimeoutMs: commandTimeoutMs(input, slots, marked),
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
      return {
        outcome: result.outcome,
        ...(result.changed === undefined ? {} : { changed: result.changed }),
      };
    },
  };
}
