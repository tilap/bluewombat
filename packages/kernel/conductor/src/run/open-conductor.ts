import { existsSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type {
  CommandResult,
  EscalationKind,
  TicketAggregate,
  WorkLedger,
} from "@bluewombat/work-ledger";
import type { AuthorityPort, ImplementTrace, TransformerPort } from "../transformers/port.js";
import {
  type Delivery,
  type DeliveryStore,
  type DeliveryUnit,
  openDelivery,
  reasonOfTraces,
} from "./delivery.js";
import { ticketWorkspacePath } from "./paths.js";
import type { ConductorRefusalCode, ProjectRunResult } from "./results.js";
import { foldMessageOf, subjectOf } from "./subject.js";

export type { ConductorRefusalCode, ProjectRunResult } from "./results.js";
export { foldMessageOf, subjectOf } from "./subject.js";

const DEFAULT_MAX_REFUSALS = 3;
const DEFAULT_TRANSFORMER_DURATION_MS = 30_000;

/** Prepare a Ticket workspace after Isolation — install deps, and so on. */
export type WarmOutcome = "warmed" | "failed" | "interrupted" | "invalid-invocation";

export type WarmPort = {
  prepare(input: { workspace: string; durationMs: number }): Promise<{ outcome: WarmOutcome }>;
};

/**
 * Bring the shared copy of the work line up to what the Authority holds, for
 * the line `target` names. Conductor asks right before it reads the copy, so a
 * ticket always starts from, and aligns with, the line as it is now.
 */
export type LinePort = {
  refresh(target: string): Promise<{ ok: true } | { ok: false; detail?: string }>;
};

export type OpenConductorOptions = {
  ledger: WorkLedger;
  transformers: TransformerPort;
  workLineStable: string;
  workspaceRoot: string;
  transformerDurationMs?: number;
  /**
   * How many Tickets of a Project may be active at once. Default 1.
   *
   * Above 1 the Project needs an Authority: a Ticket folded straight into the
   * work line would move it under the others with nobody to send them back.
   */
  maxParallel?: number;
  /**
   * Keeps the shared copy of the work line current. Absent: it is whatever its
   * owner left, as before.
   */
  line?: LinePort;
  /**
   * The outside judge of a Submission. Absent: an assembled ticket is folded
   * into the work line directly, with nobody else asked.
   */
  authority?: AuthorityPort;
  /** The work line a Submission is offered to, unless the Ticket names its own `line`. Required with an Authority. */
  workLineTarget?: string;
  /** How many times the Authority may send the work back before it escalates. */
  maxRefusals?: number;
  /**
   * Whether a local judge decides if the assembled ticket meets the
   * intention, before any Submission exists — or, without an Authority,
   * before the final fold. Absent or `false`: `validate` is not
   * declared, and `integrating` goes straight to offer (or the local judge on
   * `produce: false`).
   */
  validate?: boolean;
  /**
   * Whether the tests of a Task are written before its code. Then a pass of its
   * own runs in the Ticket's workspace first, and what it wrote is committed as a
   * checkpoint, so the producer's work is what comes after it. Absent or `false`:
   * the producer makes the code and the tests together, as before.
   */
  tests?: boolean;
  /**
   * Whether a fix is declared. A validate refusal with nothing to
   * repair it escalates on the spot rather than spending the budget on a round
   * that can only repeat the same refusal.
   */
  fixDeclared?: boolean;
  /**
   * Told at the moments a pass changes what an outsider would want to know:
   * the work is submitted. Awaited,
   * so what the caller says lands before the next step; what it throws is
   * its own problem and does not stop the run.
   */
  observe?: (moment: ConductorMoment) => Promise<void> | void;
  /**
   * Prepare the workspace once it exists, before the Builder runs in it.
   * Absent: the Builder gets whatever Isolation left — often a cold tree with
   * no dependencies. Bounded by `durationMs`; retried on the next `runProject`
   * until it returns `warmed`.
   */
  warm?: WarmPort & { durationMs: number };
};

/** One thing that happened inside a pass, for whoever is watching from outside. */
export type ConductorMoment = { kind: "submitted"; key: string; reference: string };

export type Conductor = {
  reconcile(project: string): Promise<void>;
  pause(): void;
  resume(): void;
  runProject(project: string): Promise<ProjectRunResult>;
  /**
   * Take the next Ticket of the Project that may start, within its parallel
   * limit. Nothing is run. Absent when none may: the Project is full, or
   * nothing is ready or unblocked.
   */
  claimNext(project: string): Promise<{ key: string } | undefined>;
  /**
   * Drive one Ticket the Project already holds, as far as it goes. Unlike
   * `runProject` it neither claims nor reconciles, so several can run at once.
   */
  runTicket(key: string): Promise<ProjectRunResult>;
  cancel(key: string): Promise<CommandResult>;
  /**
   * Drop a held unit without waiting for the bail clock.
   * Destroys the declared directory when one was recorded.
   */
  release(key: string): Promise<CommandResult>;
};

type DriveResult = ProjectRunResult | undefined;

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function destroy(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

/** What the next pass is told when it picks up a workspace the earlier one did not finish. */
const RESUMED_NOTE =
  "The pass before this one was stopped before it finished. What it made is in this directory: look at it before you write, and do not start over.";

/**
 * Where a Ticket's workspace is: the path the ledger declared when it was
 * made, else the one the layout gives. The declared path wins because a
 * Ticket in flight keeps its work and its git branch where they were.
 */
function declaredTicketPath(
  workspaceRoot: string,
  key: string,
  aggregate: TicketAggregate | undefined,
): string {
  return aggregate?.workspace ?? ticketWorkspacePath(workspaceRoot, key);
}

/** Whether a workspace the ledger declares is still there with something in it. */
async function stillThere(path: string | undefined): Promise<boolean> {
  if (path === undefined) {
    return false;
  }
  try {
    return (await readdir(path)).length > 0;
  } catch {
    return false;
  }
}

async function destroyOrphans(workspaceRoot: string, allowed: Set<string>): Promise<void> {
  if (!(await isDirectory(workspaceRoot))) {
    return;
  }
  const top = await readdir(workspaceRoot, { withFileTypes: true });
  for (const entry of top) {
    const keyDir = resolve(join(workspaceRoot, entry.name));
    if (!entry.isDirectory()) {
      await destroy(keyDir);
      continue;
    }
    const keepsKeyDir = [...allowed].some(
      (path) => path === keyDir || path.startsWith(`${keyDir}/`),
    );
    if (!keepsKeyDir) {
      await destroy(keyDir);
      continue;
    }
    const inner = await readdir(keyDir, { withFileTypes: true });
    for (const child of inner) {
      const childPath = resolve(join(keyDir, child.name));
      if (!allowed.has(childPath)) {
        await destroy(childPath);
      }
    }
  }
}

export function openConductor(options: OpenConductorOptions): Conductor {
  if (!isAbsolute(options.workLineStable) || !isAbsolute(options.workspaceRoot)) {
    throw new Error("Conductor workLineStable and workspaceRoot must be absolute directories.");
  }
  if (resolve(options.workLineStable) === resolve(options.workspaceRoot)) {
    throw new Error("Conductor workspaceRoot must not be the WorkLineStable path.");
  }

  const ledger = options.ledger;
  const observe = async (moment: ConductorMoment): Promise<void> => {
    try {
      await options.observe?.(moment);
    } catch {
      // The watcher's failure is not the work's.
    }
  };
  const transformers = options.transformers;
  const workLineStable = resolve(options.workLineStable);
  const workspaceRoot = resolve(options.workspaceRoot);
  const durationMs = options.transformerDurationMs ?? DEFAULT_TRANSFORMER_DURATION_MS;
  const authority = options.authority;
  const workLineTarget = options.workLineTarget ?? "";
  /** The line a Ticket lands on: its own when it names one, else the Project's. */
  const targetOf = (aggregate: TicketAggregate): string =>
    aggregate.intention.line ?? workLineTarget;
  const maxRefusals = options.maxRefusals ?? DEFAULT_MAX_REFUSALS;
  const validate = options.validate ?? false;
  const testsFirst = options.tests ?? false;
  const fixDeclared = options.fixDeclared ?? false;
  const warm = options.warm;
  const maxParallel = options.maxParallel ?? 1;
  const line = options.line;
  let paused = false;

  /**
   * One at a time over the shared copy of the work line. What runs under it is
   * brief and git's own — cutting a worktree from the copy, merging the copy
   * in — while what takes minutes (the agents, the Gates) runs in the Ticket's
   * own workspace, outside it.
   */
  let lastOnLine: Promise<unknown> = Promise.resolve();
  const onLine = <T>(job: () => Promise<T>): Promise<T> => {
    const run = lastOnLine.then(job, job);
    lastOnLine = run.catch(() => undefined);
    return run;
  };

  /** The copy brought up to the line `target`, or why it could not be. */
  const refreshLine = async (target: string): Promise<{ ok: true } | { ok: false }> => {
    if (line === undefined || target.length === 0) {
      return { ok: true };
    }
    const refreshed = await line.refresh(target);
    return refreshed.ok ? { ok: true } : { ok: false };
  };

  const refused = (code: ConductorRefusalCode): ProjectRunResult => ({
    outcome: "refused",
    code,
  });

  const fromLedger = (result: CommandResult): ProjectRunResult | undefined => {
    if (result.ok) {
      return undefined;
    }
    if (result.code === "persist-failed") {
      return refused("persist-failed");
    }
    if (
      result.code === "point-of-no-return" ||
      result.code === "project-busy" ||
      result.code === "not-found" ||
      result.code === "illegal-transition"
    ) {
      return refused(result.code);
    }
    return refused("illegal-transition");
  };

  /**
   * Freeze the Ticket for a human. If a newer fingerprint arrived in flight,
   * it is named on the escalation and consumed by the ledger.
   */
  async function freeze(
    key: string,
    input: { kind: EscalationKind; report?: string },
  ): Promise<ProjectRunResult> {
    const got = await ledger.get(key);
    const pending =
      got.ok && got.aggregate.pending_fingerprint !== undefined
        ? `The intention was edited while the work was in flight (now fingerprint ${got.aggregate.pending_fingerprint}). The work stops here for a human to decide: on resume the work starts again from zero.`
        : undefined;
    const report = [input.report, pending]
      .filter((part): part is string => part !== undefined && part.length > 0)
      .join(" ");
    const escalated = await ledger.escalate({
      key,
      kind: input.kind,
      ...(report.length === 0 ? {} : { report }),
    });
    const failure = fromLedger(escalated);
    if (failure !== undefined) {
      return failure;
    }
    return { outcome: "escalated", key };
  }

  async function freezeIfPending(key: string): Promise<ProjectRunResult | undefined> {
    const got = await ledger.get(key);
    if (!got.ok || got.aggregate.pending_fingerprint === undefined) {
      return undefined;
    }
    return await freeze(key, { kind: "unit" });
  }

  /**
   * What the corrective rounds of one ticket have used. A refusal, a conflict, a
   * recheck that failed and a line that moved on all draw on the one
   * `maxRefusals` budget: whichever loop it is, the ticket stops being corrected
   * when it is empty, not once per loop.
   */
  function spentOf(aggregate: TicketAggregate): number {
    return (
      (aggregate.submission?.refusals ?? 0) +
      (aggregate.parked_refusals ?? 0) +
      (aggregate.submission?.realigns ?? 0)
    );
  }

  /** What a Ticket's delivery reads of it, and how it keeps what the delivery decides. */
  function ticketStore(key: string): DeliveryStore {
    return {
      async read() {
        const got = await ledger.get(key);
        if (!got.ok) {
          return undefined;
        }
        const aggregate = got.aggregate;
        // A parked refusal is this round's; a Submission's is carried forward on
        // purpose and may already be repaired. The fresher one wins.
        const parked = aggregate.parked_refusal;
        const report = parked?.report ?? aggregate.submission?.last_report;
        const refusedBy = parked?.refused_by ?? aggregate.submission?.last_refused_by;
        return {
          sentBack: report === undefined ? undefined : { report, refusedBy },
          spent: spentOf(aggregate),
          submission:
            aggregate.submission === undefined
              ? undefined
              : { reference: aggregate.submission.reference },
        };
      },
      freeze: async (input) => await freeze(key, input),
      park: async (why) =>
        fromLedger(
          await ledger.recordParkedRefusal({
            key,
            report: why.report,
            ...(why.refusedBy === undefined ? {} : { refusedBy: why.refusedBy }),
          }),
        ),
      unpark: async () => fromLedger(await ledger.clearParkedRefusal(key)),
      refuse: async (why) =>
        fromLedger(
          await ledger.recordRefusal({
            key,
            report: why.report,
            ...(why.refusedBy === undefined ? {} : { refusedBy: why.refusedBy }),
          }),
        ),
      realign: async () => fromLedger(await ledger.recordRealign({ key })),
    };
  }

  /** Where a Ticket's work is and where it goes. */
  function unitOf(key: string, aggregate: TicketAggregate): DeliveryUnit {
    const workspace = declaredTicketPath(workspaceRoot, key, aggregate);
    return {
      key,
      intention: aggregate.intention.intention,
      title: aggregate.intention.title,
      noun: "ticket",
      workspace,
      judgeWorkspace: workspace,
      target: targetOf(aggregate),
      line: workLineStable,
    };
  }

  const delivery: Delivery = openDelivery({
    transformers,
    authority,
    durationMs,
    maxRefusals,
    recheck: true,
    validate,
    fixDeclared,
    onLine,
    refreshLine: async (target) => (await refreshLine(target)).ok,
    isPaused: () => paused,
  });

  /** A unit nobody is on any more: its lease runs out. Its workspace stays, for the next pass. */
  async function expireIfHeld(key: string): Promise<void> {
    await ledger.expireBail(key);
  }

  /**
   * A unit was started and a transformer stopped on interrupt. Release the
   * bail now so the next process does not wait an hour for the clock.
   *
   * The workspace stays, and so do the Attempts the pass finished: stopping Mason is not a
   * failure of the work, so the next pass picks it up where it was instead of starting over.
   * Whoever wants it started over says so (`release`).
   */
  async function releaseHeldAfterInterrupt(
    key: string,
    traces: ImplementTrace[] = [],
  ): Promise<ProjectRunResult | undefined> {
    const before = await ledger.get(key);
    if (before.ok) {
      let number = before.aggregate.attempts.length + 1;
      for (const trace of traces) {
        if (trace.ended === "interrupted") {
          continue;
        }
        const recorded = await recordFinished(key, number, trace);
        if (recorded !== undefined) {
          return recorded;
        }
        number += 1;
      }
    }
    const released = await ledger.releaseBail(key);
    if (!released.ok && released.code === "persist-failed") {
      return refused("persist-failed");
    }
    // Already free, or a state releaseBail refuses — leave the ledger and
    // still answer interrupted.
    return undefined;
  }

  async function recordFinished(
    key: string,
    number: number,
    trace: ImplementTrace,
  ): Promise<ProjectRunResult | undefined> {
    const recorded = await ledger.recordAttempt({
      key,
      number,
      trace: {
        ended: trace.ended,
        ...(trace.report === undefined || trace.report.length === 0
          ? {}
          : { report: trace.report }),
        ...(trace.refusedBy === undefined ? {} : { refusedBy: trace.refusedBy }),
      },
    });
    return fromLedger(recorded);
  }

  async function reconcile(project: string): Promise<void> {
    const declared = await ledger.listDeclaredWorkspaces();
    const allowed = new Set<string>();
    for (const row of declared) {
      allowed.add(resolve(row.path));
    }
    await destroyOrphans(workspaceRoot, allowed);
    for (const row of declared) {
      await expireIfHeld(row.key);
    }
    const active = await ledger.activeOn(project);
    if (active !== undefined) {
      await expireIfHeld(active.key);
    }
  }

  async function destroyDeclared(key: string): Promise<void> {
    const got = await ledger.get(key);
    if (!got.ok) {
      return;
    }
    if (got.aggregate.workspace !== undefined) {
      await destroy(got.aggregate.workspace);
    }
    await ledger.clearWorkspace(key);
  }

  /**
   * Make the Ticket's workspace from nothing: a unit that starts, starts from
   * zero, so what an earlier pass left is destroyed first. No lease is held
   * yet: a failure here costs no Attempt, and the next pass makes it again.
   */
  async function isolateFresh(key: string): Promise<ProjectRunResult | undefined> {
    const got = await ledger.get(key);
    if (!got.ok) {
      return refused("not-found");
    }
    const workspace = declaredTicketPath(workspaceRoot, key, got.aggregate);
    if (existsSync(workspace)) {
      await destroy(workspace);
    }
    const declared = await ledger.declareWorkspace({ key, path: workspace });
    const declareFail = fromLedger(declared);
    if (declareFail !== undefined) {
      return declareFail;
    }
    // Cut from the line as it is now, with nobody moving it meanwhile.
    const target = targetOf(got.aggregate);
    const cut = await onLine(async () => {
      if (!(await refreshLine(target)).ok) {
        return undefined;
      }
      return await transformers.isolate({
        id: key,
        context: key,
        parent: workLineStable,
        child: workspace,
        durationMs,
      });
    });
    if (cut === undefined) {
      return refused("line-refresh-failed");
    }
    const isolated = cut;
    if (isolated.outcome === "interrupted") {
      return refused("interrupted");
    }
    if (isolated.outcome !== "isolated") {
      return refused(
        isolated.outcome === "invalid-invocation" ? "transformer-invalid" : "isolate-failed",
      );
    }
    if (warm !== undefined) {
      const prepared = await warm.prepare({ workspace, durationMs: warm.durationMs });
      if (prepared.outcome === "interrupted") {
        return refused("interrupted");
      }
      if (prepared.outcome === "invalid-invocation") {
        return refused("transformer-invalid");
      }
      if (prepared.outcome !== "warmed") {
        return refused("warm-failed");
      }
    }
    return undefined;
  }

  /**
   * The tests of the Task, before its code.
   *
   * Their own agent writes them in the Ticket's workspace and their own Gates
   * judge them (they must fail, for the right reason). What they wrote is then
   * committed — a checkpoint, by folding the workspace into itself, which the
   * Integration does by committing what is loose — so that the producer's work is
   * what differs from it afterwards, and its Gates can see whether a test was
   * touched.
   *
   * `undefined` when the code may be written; otherwise the result that ends the
   * pass. Nothing of this is an Attempt of the unit: a pass that fails here is a
   * Task whose tests could not be written, and a person looks.
   */
  async function writeTestsFirst(
    key: string,
    aggregate: TicketAggregate,
    workspace: string,
  ): Promise<ProjectRunResult | undefined> {
    const written = await transformers.implement({
      id: `${key}:tests`,
      context: key,
      stage: "tests",
      produce: true,
      intention: aggregate.intention.intention,
      workspace,
    });
    if (written.outcome === "interrupted") {
      const failure = await releaseHeldAfterInterrupt(key);
      return failure ?? refused("interrupted");
    }
    if (written.outcome === "invalid-invocation") {
      return refused("transformer-invalid");
    }
    if (written.outcome === "escalated") {
      const why = reasonOfTraces(written.traces);
      return await freeze(key, {
        kind: "unit",
        report: `The tests could not be written first.${why === undefined ? "" : ` ${why}`}`,
      });
    }
    const checkpoint = await transformers.integrate({
      id: `${key}:tests`,
      context: key,
      parent: workspace,
      child: workspace,
      durationMs,
      subject: `Tests: ${subjectOf(aggregate.intention.title ?? aggregate.intention.intention)}`,
    });
    if (checkpoint.outcome === "interrupted") {
      const failure = await releaseHeldAfterInterrupt(key);
      return failure ?? refused("interrupted");
    }
    if (checkpoint.outcome !== "integrated") {
      return await freeze(key, {
        kind: "unit",
        report: "The tests that were written first could not be committed.",
      });
    }
    // A pass that is stopped from here on does not write them again.
    const marked = await ledger.markFirstStageDone(key);
    return fromLedger(marked);
  }

  /**
   * Run the unit: Builder, then the Gates, in the workspace Isolation made.
   * The result stays loose in the workspace; the Integration in `doIntegrating`
   * is what takes it up.
   */
  async function doRunning(key: string): Promise<DriveResult> {
    if (paused) {
      return { outcome: "paused", key };
    }
    const before = await ledger.get(key);
    if (!before.ok) {
      return refused("not-found");
    }
    if (before.aggregate.state !== "running") {
      return undefined;
    }
    if (before.aggregate.bail !== undefined) {
      // A unit is held: its lease runs out on its own if nobody is on it.
      return { outcome: "paused", key };
    }
    // A pass that was stopped (Mason stopped, or died) leaves its workspace declared: this one
    // picks it up. A unit that starts with nothing left starts from zero.
    const resumed = await stillThere(before.aggregate.workspace);
    if (!resumed) {
      const isolated = await isolateFresh(key);
      if (isolated !== undefined) {
        return isolated;
      }
    }
    if (paused) {
      return { outcome: "paused", key };
    }
    const started = await ledger.startUnit(key);
    const startFail = fromLedger(started);
    if (startFail !== undefined) {
      return startFail;
    }
    const got = await ledger.get(key);
    if (!got.ok) {
      return refused("not-found");
    }
    const unitPath = declaredTicketPath(workspaceRoot, key, got.aggregate);
    // The tracker can say a ticket has no tests written first: a label, not a line of its text.
    if (
      testsFirst &&
      got.aggregate.intention.no_tests !== true &&
      got.aggregate.first_stage_done !== true
    ) {
      const stopped = await writeTestsFirst(key, got.aggregate, unitPath);
      if (stopped !== undefined) {
        return stopped;
      }
    }
    // The Attempts the stopped pass finished count, and the next one goes on from them.
    const earlier = resumed
      ? got.aggregate.attempts.filter((attempt) => attempt.round === got.aggregate.resumes)
      : [];
    const last = earlier[earlier.length - 1]?.trace;
    const carried = last?.ended === "fail-retryable" ? last : undefined;
    const report = carried?.report ?? (resumed ? RESUMED_NOTE : undefined);
    const implemented = await transformers.implement({
      id: key,
      context: key,
      intention: got.aggregate.intention.intention,
      workspace: unitPath,
      ...(report === undefined ? {} : { report }),
      ...(carried?.refusedBy === undefined ? {} : { reportFrom: carried.refusedBy }),
      ...(earlier.length === 0 ? {} : { firstAttempt: earlier.length + 1 }),
    });
    if (implemented.outcome === "interrupted") {
      const failure = await releaseHeldAfterInterrupt(key, implemented.traces);
      return failure ?? refused("interrupted");
    }
    if (implemented.outcome === "invalid-invocation") {
      return refused("transformer-invalid");
    }
    let number = got.aggregate.attempts.length + 1;
    for (const trace of implemented.traces) {
      const recorded = await ledger.recordAttempt({
        key,
        number,
        trace: {
          ended: trace.ended,
          ...(trace.report === undefined || trace.report.length === 0
            ? {}
            : { report: trace.report }),
          ...(trace.refusedBy === undefined ? {} : { refusedBy: trace.refusedBy }),
        },
      });
      const failure = fromLedger(recorded);
      if (failure !== undefined) {
        return failure;
      }
      number += 1;
    }
    if (implemented.outcome === "escalated") {
      const why = reasonOfTraces(implemented.traces);
      return await freeze(key, {
        kind: "unit",
        ...(why === undefined ? {} : { report: why }),
      });
    }
    const marked = await ledger.markIntegrating(key);
    const markFail = fromLedger(marked);
    if (markFail !== undefined) {
      return markFail;
    }
    return await freezeIfPending(key);
  }

  async function doIntegrating(key: string): Promise<DriveResult> {
    if (paused) {
      return { outcome: "paused", key };
    }
    const pending = await freezeIfPending(key);
    if (pending !== undefined) {
      return pending;
    }
    const got = await ledger.get(key);
    if (!got.ok) {
      return refused("not-found");
    }
    const unit = unitOf(key, got.aggregate);
    const prepared = await delivery.prepare(unit, ticketStore(key));
    if (prepared !== "ready") {
      return prepared;
    }
    if (authority === undefined) {
      // Nobody outside will look at it, so the Project's own sequence is the
      // only judgement the assembled ticket gets. Skipping it here would let
      // work into the work line that nothing ever judged as a whole.
      const judged = await delivery.judge(unit);
      if (judged.outcome === "interrupted") {
        return refused("interrupted");
      }
      if (judged.outcome === "invalid-invocation") {
        return refused("transformer-invalid");
      }
      if (judged.outcome === "escalated") {
        const why = reasonOfTraces(judged.traces);
        return await freeze(key, {
          kind: "assembly",
          ...(why === undefined ? {} : { report: why }),
        });
      }
      const merging = await ledger.markMerging(key);
      return fromLedger(merging);
    }
    return await offer(key, got.aggregate);
  }

  /**
   * Put the assembled ticket in front of the Authority.
   *
   * A ticket already submitted is offered again rather than a second time:
   * the work was published to the same place, so the Authority is judging the
   * same Submission with new content.
   */
  async function offer(key: string, aggregate: TicketAggregate): Promise<ProjectRunResult> {
    if (authority === undefined) {
      return refused("transformer-invalid");
    }
    const title = aggregate.intention.title;
    const intention = aggregate.intention.intention;
    const submitted = await authority.submit({
      key,
      project: aggregate.intention.project,
      ref: key,
      target: targetOf(aggregate),
      workspace: declaredTicketPath(workspaceRoot, key, aggregate),
      ...(title === undefined ? {} : { title }),
      ...(intention === undefined ? {} : { intention }),
    });
    if (submitted.outcome === "unavailable") {
      // Nothing is lost: the state still says integrating, and the next pass
      // offers it again.
      return { outcome: "paused", key };
    }
    if (submitted.outcome === "refused") {
      return await freeze(key, { kind: "submitted", report: submitted.reason });
    }
    const marked = await ledger.markSubmitted({ key, reference: submitted.reference });
    const failure = fromLedger(marked);
    if (failure !== undefined) {
      return failure;
    }
    await observe({ kind: "submitted", key, reference: submitted.reference });
    return { outcome: "paused", key };
  }

  async function doSubmitted(key: string): Promise<ProjectRunResult> {
    const got = await ledger.get(key);
    if (!got.ok) {
      return refused("not-found");
    }
    const ticketPath = declaredTicketPath(workspaceRoot, key, got.aggregate);
    const settled = await delivery.settle(unitOf(key, got.aggregate), ticketStore(key));
    if (!("folded" in settled)) {
      return settled;
    }
    // The Authority folded it. The work line moved; this system's copy has not,
    // and whoever wired the Authority is the one that brings it up to date.
    const merging = await ledger.markMerging(key);
    const mergingFailure = fromLedger(merging);
    if (mergingFailure !== undefined) {
      return mergingFailure;
    }
    const done = await ledger.markDone(key, { reference: settled.reference });
    const doneFailure = fromLedger(done);
    if (doneFailure !== undefined) {
      return doneFailure;
    }
    await destroy(ticketPath);
    await ledger.clearWorkspace(key);
    return { outcome: "done", key };
  }

  async function doMerging(key: string): Promise<ProjectRunResult> {
    const got = await ledger.get(key);
    const ticketPath = declaredTicketPath(workspaceRoot, key, got.ok ? got.aggregate : undefined);
    const title = got.ok
      ? (got.aggregate.intention.title ?? got.aggregate.intention.intention)
      : key;
    const folded = await onLine(
      async () =>
        await transformers.integrate({
          id: key,
          context: key,
          parent: workLineStable,
          child: ticketPath,
          durationMs,
          subject: foldMessageOf(title),
          mergeSubject: `Merge ${subjectOf(title)}`,
        }),
    );
    if (folded.outcome === "interrupted") {
      return refused("interrupted");
    }
    if (folded.outcome === "conflict") {
      return await freeze(key, { kind: "merging" });
    }
    if (folded.outcome !== "integrated") {
      return refused("transformer-invalid");
    }
    const done = await ledger.markDone(key);
    const failure = fromLedger(done);
    if (failure !== undefined) {
      return failure;
    }
    await destroy(ticketPath);
    await ledger.clearWorkspace(key);
    return { outcome: "done", key };
  }

  /**
   * The assembled work is in the workspace and nowhere else. When it is gone,
   * making it again from the work line would drop what was made, and when the
   * Authority holds a Submission built from it, publish over what it was
   * shown. Either is a human's call, not this loop's.
   */
  async function workspaceGone(key: string): Promise<ProjectRunResult | undefined> {
    const got = await ledger.get(key);
    if (!got.ok) {
      return refused("not-found");
    }
    if (existsSync(declaredTicketPath(workspaceRoot, key, got.aggregate))) {
      return undefined;
    }
    return await freeze(key, {
      kind: got.aggregate.submission === undefined ? "assembly" : "submitted",
      report: "The workspace the work was assembled in is gone.",
    });
  }

  async function drive(key: string): Promise<ProjectRunResult> {
    const runningResult = await doRunning(key);
    if (runningResult !== undefined) {
      return runningResult;
    }
    const got = await ledger.get(key);
    if (!got.ok) {
      return refused("not-found");
    }
    if (got.aggregate.state === "escalated") {
      return { outcome: "escalated", key };
    }
    if (got.aggregate.state === "running") {
      return { outcome: "paused", key };
    }
    if (got.aggregate.state === "done") {
      return { outcome: "done", key };
    }
    const gone = await workspaceGone(key);
    if (gone !== undefined) {
      return gone;
    }
    if (got.aggregate.state === "integrating") {
      const integratingResult = await doIntegrating(key);
      if (integratingResult !== undefined) {
        return integratingResult;
      }
    }
    const after = await ledger.get(key);
    if (!after.ok) {
      return refused("not-found");
    }
    if (after.aggregate.state === "submitted") {
      return await doSubmitted(key);
    }
    if (after.aggregate.state === "merging") {
      return await doMerging(key);
    }
    if (after.aggregate.state === "done") {
      return { outcome: "done", key };
    }
    if (after.aggregate.state === "escalated") {
      return { outcome: "escalated", key };
    }
    return { outcome: "paused", key };
  }

  return {
    async reconcile(project: string): Promise<void> {
      await reconcile(project);
    },

    pause(): void {
      paused = true;
    },

    resume(): void {
      paused = false;
    },

    async runProject(project: string): Promise<ProjectRunResult> {
      if (!(await isDirectory(workLineStable))) {
        return refused("stable-missing");
      }
      await reconcile(project);
      const active = await ledger.activeOn(project);
      if (active !== undefined) {
        return await drive(active.key);
      }
      if (paused) {
        return { outcome: "paused" };
      }
      const claimed = await ledger.claim(project, maxParallel);
      if (!claimed.ok) {
        const failure = fromLedger(claimed);
        return failure ?? refused("illegal-transition");
      }
      if ("empty" in claimed) {
        return { outcome: "idle" };
      }
      return await drive(claimed.key);
    },

    async claimNext(project: string): Promise<{ key: string } | undefined> {
      if (paused || !(await isDirectory(workLineStable))) {
        return undefined;
      }
      const claimed = await ledger.claim(project, maxParallel);
      return claimed.ok && "key" in claimed ? { key: claimed.key } : undefined;
    },

    async runTicket(key: string): Promise<ProjectRunResult> {
      if (!(await isDirectory(workLineStable))) {
        return refused("stable-missing");
      }
      return await drive(key);
    },

    async cancel(key: string): Promise<CommandResult> {
      const cancelled = await ledger.cancel(key);
      if (cancelled.ok) {
        await destroyDeclared(key);
      }
      return cancelled;
    },

    async release(key: string): Promise<CommandResult> {
      const before = await ledger.get(key);
      const child = before.ok ? before.aggregate.workspace : undefined;
      const released = await ledger.releaseBail(key);
      if (released.ok && child !== undefined) {
        // The way to start a unit over: what a stopped pass left is dropped, not picked up.
        await destroy(child);
        await ledger.clearWorkspace(key);
      }
      return released;
    },
  };
}
