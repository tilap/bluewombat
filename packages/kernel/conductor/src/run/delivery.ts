import type {
  AuthorityPort,
  ImplementResult,
  ImplementTrace,
  TransformerPort,
} from "../transformers/port.js";
import type { ProjectRunResult } from "./results.js";
import { foldMessageOf } from "./subject.js";

/**
 * Getting assembled work from where it was made to where it lands.
 *
 * A Ticket does it to the Feature's line and a Feature does it to the Project's
 * final one; the steps are the same and only what they are given differs. This
 * module is the steps. It reads nothing from the ledger and writes nothing to
 * it: whoever uses it says where the work is (`DeliveryUnit`), how a refusal is
 * kept (`DeliveryStore`), and what the checks are (the Transformers).
 *
 * The steps, in order, each a pass that may end the pass early:
 *
 * 1. a fix, when something refused the last round and said why;
 * 2. the align: the line brought into the work, and a conflict sent to the fix;
 * 3. the work's own checks again, when the align or a fix changed the code
 *    (a Ticket has them; a Feature's are part of its review);
 * 4. a local review, when the Project has one;
 * — then the work is offered, which is the user's business (it is published in
 *   different ways) — and later:
 * 5. the judgement of what was published;
 * 6. whether the line moved on meanwhile, and a realign if so;
 * 7. the fold.
 */

/** The work to deliver, and where everything about it is. */
export type DeliveryUnit = {
  /** The Ticket's or the Feature's key; every Transformer id derives from it. */
  key: string;
  intention: string;
  title?: string | undefined;
  /** What it is called in what is said about it. */
  noun: "ticket" | "feature";
  /** Where the work is: the Transformers produce, align and check here. */
  workspace: string;
  /** Where the Gates read the published work: its branch is checked out here. */
  judgeWorkspace: string;
  /** The line it is offered to; empty when the Project names none. */
  target: string;
  /** The directory holding that line, merged into the work at the align. */
  line: string;
};

/** What the delivery needs to know of the unit's state, read fresh at each step. */
export type DeliveryRead = {
  /** What refused the last round, when something did. The fresher of a parked refusal and a Submission's. */
  sentBack?: { report: string; refusedBy?: string | undefined } | undefined;
  /** Corrective rounds spent: refusals, parked refusals and realigns together. */
  spent: number;
  /** The Submission the work is offered under, once there is one. */
  submission?: { reference: string } | undefined;
};

/**
 * How the unit keeps what the delivery decides. Each write answers `undefined`
 * when it was done, or the result that ends the pass when it was refused.
 */
export type DeliveryStore = {
  read(): Promise<DeliveryRead | undefined>;
  /** Stop for a person. */
  freeze(input: {
    kind: "assembly" | "submitted";
    report?: string;
    /** What refused the work, when it said its name. The report already carries it as a prefix. */
    refusedBy?: string | undefined;
  }): Promise<ProjectRunResult>;
  /** A check refused the work before it was published: keep why, for the fix. */
  park(why: {
    report: string;
    refusedBy?: string | undefined;
  }): Promise<ProjectRunResult | undefined>;
  /** Whatever sent the work back is repaired and checked. */
  unpark(): Promise<ProjectRunResult | undefined>;
  /** The Authority's judgement refused the Submission: keep why, and go back to the fix. */
  refuse(why: {
    report: string;
    refusedBy?: string | undefined;
  }): Promise<ProjectRunResult | undefined>;
  /** The line moved on under the Submission: go back to be aligned. */
  realign(): Promise<ProjectRunResult | undefined>;
};

export type DeliveryOptions = {
  transformers: TransformerPort;
  /** Absent: the work is not offered outside, and `settle` has nothing to ask. */
  authority?: AuthorityPort | undefined;
  durationMs: number;
  maxRefusals: number;
  /** Whether the unit's own checks run again after the align (the Ticket's `builder.gates`). */
  recheck: boolean;
  /** Whether a local review follows. For a Feature it is also where its checks run. */
  validate: boolean;
  /** Whether anything can repair a refusal. Without it a refusal is for a person. */
  fixDeclared: boolean;
  /** One job at a time over the directories the line lives in. */
  onLine<T>(job: () => Promise<T>): Promise<T>;
  /** The directory of the line brought up to date with it; false when it could not be. */
  refreshLine(target: string): Promise<boolean>;
  isPaused(): boolean;
};

export type Delivery = {
  /** Steps 1 to 4. `ready` means the work may be offered. */
  prepare(unit: DeliveryUnit, store: DeliveryStore): Promise<"ready" | ProjectRunResult>;
  /** The Gates' judgement of the published work; nothing is produced. */
  judge(unit: DeliveryUnit): Promise<ImplementResult>;
  /** Steps 5 to 7. `folded` is the one outcome that is not a pass of its own. */
  settle(
    unit: DeliveryUnit,
    store: DeliveryStore,
  ): Promise<{ folded: true; reference?: string | undefined } | ProjectRunResult>;
};

/** What the last Attempt ended on, for whoever reads the escalation. */
export function reasonOfTraces(traces: ImplementTrace[]): string | undefined {
  const last = traces.at(-1);
  const report = last?.report?.trim();
  if (report === undefined || report.length === 0) {
    return undefined;
  }
  return last?.refusedBy === undefined ? report : `${last.refusedBy}: ${report}`;
}

export function openDelivery(options: DeliveryOptions): Delivery {
  const { transformers, authority, durationMs, maxRefusals } = options;

  const refused = (code: "interrupted" | "transformer-invalid" | "line-refresh-failed") =>
    ({ outcome: "refused", code }) satisfies ProjectRunResult;

  /**
   * Something broke or refused the work before it was published: hand it to the
   * fix with the reason. A human is asked only when nothing can fix it (no fix
   * declared, a blocking refusal) or the budget is spent.
   */
  async function sendBack(
    unit: DeliveryUnit,
    store: DeliveryStore,
    read: DeliveryRead,
    why: { report: string; refusedBy?: string | undefined; blocking?: boolean },
  ): Promise<ProjectRunResult> {
    const canRepair = options.fixDeclared && why.blocking !== true && read.spent + 1 < maxRefusals;
    if (!canRepair) {
      return await store.freeze({
        kind: "assembly",
        report: why.refusedBy === undefined ? why.report : `${why.refusedBy}: ${why.report}`,
        refusedBy: why.refusedBy,
      });
    }
    const failure = await store.park(why);
    if (failure !== undefined) {
      return failure;
    }
    // Repair is on its way: do not offer, or judge, work that is already known to
    // need it. The next pass produces the fix, then aligns and checks again.
    return { outcome: "paused", key: unit.key };
  }

  /**
   * The line moved on under a Submission, or refused the fold: go back to be
   * aligned with it, judged and published again. Nothing was wrong with the
   * work, so there is no report to repair; the round still counts.
   */
  async function realign(
    unit: DeliveryUnit,
    store: DeliveryStore,
    read: DeliveryRead,
    why: string,
  ): Promise<ProjectRunResult> {
    if (read.spent + 1 >= maxRefusals) {
      return await store.freeze({
        kind: "submitted",
        report: `${why} This ${unit.noun} has used all its corrective rounds, so it stops here for a person.`,
      });
    }
    const failure = await store.realign();
    if (failure !== undefined) {
      return failure;
    }
    return { outcome: "paused", key: unit.key };
  }

  async function judge(unit: DeliveryUnit): Promise<ImplementResult> {
    return await transformers.implement({
      id: `${unit.key}:judgement`,
      context: unit.key,
      stage: unit.noun,
      produce: false,
      intention: unit.intention,
      workspace: unit.judgeWorkspace,
    });
  }

  async function prepare(
    unit: DeliveryUnit,
    store: DeliveryStore,
  ): Promise<"ready" | ProjectRunResult> {
    const read = await store.read();
    if (read === undefined) {
      return { outcome: "refused", code: "not-found" };
    }
    const line = unit.target.length > 0 ? unit.target : "the work line";
    const sentBack = read.sentBack;
    if (sentBack !== undefined) {
      // Something refused the last round and said why. That report is the only
      // reason this stage has to produce: the unit is already validated.
      //
      // Before the Integration below, and that order is the whole point. What a
      // producer leaves is loose in the workspace; the Integration is the only
      // thing that takes it up. Producing after it means the repair waits for
      // the next round to be taken up at all, and what goes out meanwhile is the
      // state that was already refused — the same refusal comes back, and the
      // budget empties on the delay.
      const remade = await transformers.implement({
        id: `${unit.key}:fix`,
        context: unit.key,
        stage: unit.noun,
        produce: true,
        intention: unit.intention,
        workspace: unit.workspace,
        report: sentBack.report,
        ...(sentBack.refusedBy === undefined ? {} : { reportFrom: sentBack.refusedBy }),
      });
      if (remade.outcome === "interrupted") {
        return refused("interrupted");
      }
      if (remade.outcome === "invalid-invocation") {
        return refused("transformer-invalid");
      }
      if (remade.outcome === "escalated") {
        // The assembled work, not the unit: naming the unit here sends a reader
        // to look at work that did not fail.
        const why = reasonOfTraces(remade.traces);
        return await store.freeze({
          kind: "assembly",
          ...(why === undefined ? {} : { report: why }),
        });
      }
    }
    // The line is brought current first: aligning with a copy that is behind
    // would leave a Submission as far behind as it was, and send it round again.
    const aligned = await options.onLine(async () => {
      if (!(await options.refreshLine(unit.target))) {
        return undefined;
      }
      return await transformers.integrate({
        id: `${unit.key}:align`,
        context: unit.key,
        parent: unit.workspace,
        child: unit.line,
        durationMs,
        // What is loose in the workspace here is the work the Builder made, or a
        // repair of it.
        subject:
          sentBack === undefined
            ? foldMessageOf(unit.title ?? unit.intention)
            : "Repair after it was refused",
        mergeSubject: `Merge ${line} into the ${unit.noun}`,
      });
    });
    if (aligned === undefined) {
      return refused("line-refresh-failed");
    }
    if (aligned.outcome === "interrupted") {
      return refused("interrupted");
    }
    if (aligned.outcome === "conflict") {
      // Not a place to stop: the fix is told what happened and does the merge by hand.
      return await sendBack(unit, store, read, {
        report:
          `Merging the line "${line}" into this ${unit.noun} ` +
          `conflicts: the ${unit.noun} and the line changed the same places. Look at what the line ` +
          `changed since this ${unit.noun} started, and adapt the ${unit.noun}'s changes so they sit on top ` +
          "of it. Keep what the line changed.",
        refusedBy: "align",
      });
    }
    if (aligned.outcome !== "integrated") {
      return refused("transformer-invalid");
    }
    if (options.isPaused()) {
      return { outcome: "paused", key: unit.key };
    }
    // The unit's own checks again, on what is there now. Skipped only when the
    // code is the one they already passed: nothing was repaired this round and
    // the line brought nothing in. `changed` absent means the fold could not
    // say, which counts as changed.
    const unchanged = !options.recheck || (sentBack === undefined && aligned.changed === false);
    const rechecked = unchanged
      ? ({ outcome: "validated", traces: [] } satisfies ImplementResult)
      : await transformers.implement({
          id: `${unit.key}:recheck`,
          context: unit.key,
          stage: unit.noun,
          produce: false,
          recheck: true,
          intention: unit.intention,
          workspace: unit.workspace,
        });
    if (rechecked.outcome === "interrupted") {
      return refused("interrupted");
    }
    if (rechecked.outcome === "invalid-invocation") {
      return refused("transformer-invalid");
    }
    if (rechecked.outcome === "escalated") {
      const last = rechecked.traces.at(-1);
      return await sendBack(unit, store, read, {
        report:
          last?.report ??
          `The checks failed after the ${unit.noun} was aligned with the line, with no reason given.`,
        ...(last?.refusedBy === undefined ? {} : { refusedBy: last.refusedBy }),
        blocking: last?.ended === "fail-blocking",
      });
    }
    // Whatever sent the work back is repaired and checked: it no longer asks for a fix.
    const settled = await store.unpark();
    if (settled !== undefined) {
      return settled;
    }
    if (options.validate) {
      const validated = await transformers.implement({
        id: `${unit.key}:validate`,
        context: unit.key,
        stage: unit.noun,
        validate: true,
        intention: unit.intention,
        workspace: unit.workspace,
      });
      if (validated.outcome === "interrupted") {
        return refused("interrupted");
      }
      if (validated.outcome === "invalid-invocation") {
        return refused("transformer-invalid");
      }
      if (validated.outcome === "escalated") {
        const last = validated.traces.at(-1);
        return await sendBack(unit, store, read, {
          report: last?.report ?? `The assembled ${unit.noun} was refused, with no reason given.`,
          ...(last?.refusedBy === undefined ? {} : { refusedBy: last.refusedBy }),
          blocking: last?.ended === "fail-blocking",
        });
      }
      const cleared = await store.unpark();
      if (cleared !== undefined) {
        return cleared;
      }
    }
    return "ready";
  }

  async function settle(
    unit: DeliveryUnit,
    store: DeliveryStore,
  ): Promise<{ folded: true; reference?: string | undefined } | ProjectRunResult> {
    const read = await store.read();
    if (read === undefined) {
      return { outcome: "refused", code: "not-found" };
    }
    const submission = read.submission;
    if (authority === undefined || submission === undefined) {
      return refused("transformer-invalid");
    }
    const judged = await judge(unit);
    if (judged.outcome === "interrupted") {
      return refused("interrupted");
    }
    if (judged.outcome === "invalid-invocation") {
      return refused("transformer-invalid");
    }

    if (judged.outcome === "escalated") {
      const last = judged.traces.at(-1);
      const report = last?.report ?? "The Submission was refused, with no reason given.";
      // A blocking refusal is not something another round repairs, and neither
      // is one more refusal than the budget allows.
      if (last?.ended === "fail-blocking" || read.spent + 1 >= maxRefusals) {
        // The refusal that stopped it is never recorded as one — this is the
        // only place it can be kept for the person who reads the escalation.
        return await store.freeze({
          kind: "submitted",
          report: last?.refusedBy === undefined ? report : `${last.refusedBy}: ${report}`,
          refusedBy: last?.refusedBy,
        });
      }
      const failure = await store.refuse({ report, refusedBy: last?.refusedBy });
      if (failure !== undefined) {
        return failure;
      }
      // Back to where the work is made. The next pass produces with that report
      // in hand and publishes to the same place.
      return { outcome: "paused", key: unit.key };
    }

    // The Gates judged the work as it was published. If the line has moved on
    // since — a person pushed to it, or later a ticket folded into it — a fold
    // would produce something nobody judged. Go back to be aligned with the
    // line again, then judged again, instead of folding.
    const moved = await authority.behind?.({ reference: submission.reference });
    if (moved?.outcome === "unavailable") {
      return { outcome: "paused", key: unit.key };
    }
    if (moved?.outcome === "behind") {
      // Back to where the work is aligned. The next pass brings the work line copy
      // up to date, merges it into the work, checks it, judges it and publishes
      // to the same place.
      return await realign(
        unit,
        store,
        read,
        "The line moved on while this Submission waited to be folded, so what was judged is not what a fold would produce.",
      );
    }

    const folded = await authority.fold({ reference: submission.reference });
    if (folded.outcome === "unavailable") {
      return { outcome: "paused", key: unit.key };
    }
    if (folded.outcome === "conflict") {
      // The Authority will not fold it as it stands: go back and be aligned with the
      // line again. If the alignment conflicts, the fix is told.
      return await realign(unit, store, read, `The Authority refused the fold: ${folded.reason}`);
    }
    return { folded: true, reference: folded.reference };
  }

  return { prepare, judge, settle };
}
