import { existsSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type {
  CommandResult,
  EscalationKind,
  FeatureAdmission,
  FeatureAggregate,
  WorkLedger,
} from "@bluewombat/work-ledger";
import type {
  AuthorityPort,
  ImplementResult,
  ImplementTrace,
  TransformerPort,
} from "../transformers/port.js";
import { featureWorkspacePath, subtaskWorkspacePath } from "./paths.js";

const DEFAULT_MAX_REFUSALS = 3;
const DEFAULT_TRANSFORMER_DURATION_MS = 30_000;

export type ConductorRefusalCode =
  | "stable-missing"
  | "root-invalid"
  | "persist-failed"
  | "interrupted"
  | "isolate-failed"
  | "warm-failed"
  | "align-conflict"
  | "transformer-invalid"
  | "unavailable"
  | "not-found"
  | "point-of-no-return"
  | "project-busy"
  | "illegal-transition";

/** Prepare a Feature workspace after Isolation — install deps, and so on. */
export type WarmOutcome = "warmed" | "failed" | "interrupted" | "invalid-invocation";

export type WarmPort = {
  prepare(input: { workspace: string; durationMs: number }): Promise<{ outcome: WarmOutcome }>;
};

export type ProjectRunResult =
  | { outcome: "idle" }
  | { outcome: "done"; key: string }
  | { outcome: "escalated"; key: string }
  | { outcome: "paused"; key?: string }
  | { outcome: "refused"; code: ConductorRefusalCode };

export type OpenConductorOptions = {
  ledger: WorkLedger;
  transformers: TransformerPort;
  workLineStable: string;
  workspaceRoot: string;
  transformerDurationMs?: number;
  /**
   * The outside judge of a Submission. Absent: an assembled feature is folded
   * into the work line directly, with nobody else asked.
   */
  authority?: AuthorityPort;
  /** The work line a Submission is offered to. Required with an Authority. */
  workLineTarget?: string;
  /** How many times the Authority may send the work back before it escalates. */
  maxRefusals?: number;
  /**
   * Whether a local judge decides if the assembled feature meets the
   * intention, before any Submission exists — or, without an Authority,
   * before the final fold. Absent or `false`: `assembly.validate` is not
   * declared, and `integrating` goes straight to offer (or the local judge on
   * `produce: false`), as before.
   */
  assemblyValidate?: boolean;
  /**
   * Whether `assembly.fix` is declared. A validate refusal with nothing to
   * repair it escalates on the spot rather than spending the budget on a round
   * that can only repeat the same refusal.
   */
  assemblyFixDeclared?: boolean;
  /**
   * Told at the moments a pass changes what an outsider would want to know:
   * the plan is in, a Subtask is integrated, the work is submitted. Awaited,
   * so what the caller says lands before the next step; what it throws is
   * its own problem and does not stop the run.
   */
  observe?: (moment: ConductorMoment) => Promise<void> | void;
  /**
   * Prepare the Feature workspace once it exists, before any Subtask is
   * isolated from it. Absent: Subtasks inherit whatever Isolation left —
   * often a cold tree with no dependencies. Bounded by `durationMs`; retried
   * on the next `runProject` until it returns `warmed`.
   */
  warm?: WarmPort & { durationMs: number };
};

/** One thing that happened inside a pass, for whoever is watching from outside. */
export type ConductorMoment =
  | { kind: "planned"; key: string }
  | {
      kind: "subtask-integrated";
      key: string;
      subtaskId: string;
      integrated: number;
      total: number;
    }
  | { kind: "submitted"; key: string; reference: string };

export type Conductor = {
  reconcile(project: string): Promise<void>;
  pause(): void;
  resume(): void;
  runProject(project: string): Promise<ProjectRunResult>;
  cancel(key: string): Promise<CommandResult>;
  /**
   * Drop a held Subtask (or planning) without waiting for the bail clock.
   * Destroys the declared Subtask directory when one was recorded.
   */
  release(key: string): Promise<CommandResult>;
};

type DriveResult = ProjectRunResult | undefined;

function featureJsonOf(admission: FeatureAdmission): string {
  const document: Record<string, unknown> = {
    key: admission.key,
    intention: admission.intention,
  };
  if (admission.title !== undefined) {
    document.title = admission.title;
  }
  return JSON.stringify(document);
}

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

/**
 * Where a feature's workspace is: the path the ledger declared when it was
 * made, else the one the current layout gives. The declared path wins because a
 * feature in flight — escalated, resumed — keeps its work and its git branch
 * where they were; a layout that changed since must not strand them.
 */
function declaredFeaturePath(
  workspaceRoot: string,
  key: string,
  aggregate: FeatureAggregate | undefined,
): string {
  return aggregate?.workspaces?.feature ?? featureWorkspacePath(workspaceRoot, key);
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

const SUBJECT_MAX = 72;

/**
 * A fold's subject out of prose. Text written the way a commit is — a headline,
 * a blank line, the rest — gives its headline. Otherwise the first sentence,
 * cut at a word when even that runs past what one line of history shows. A
 * subject is not markdown, so the backticks prose uses for names come off; and
 * it ends on a word, not on an ellipsis — the whole text follows in the body
 * for whoever wants it.
 */
export function subjectOf(text: string): string {
  const trimmed = text.trim();
  const headline = /^([^\n]+)\n\s*\n/.exec(trimmed)?.[1];
  const oneLine = (headline ?? trimmed).replace(/\s+/g, " ");
  // A sentence ends where the next one starts with a capital, or where the
  // text ends: "e.g. foo" and "src/index.js" are not sentence ends.
  const sentence = /^(.*?[.!?])(?:\s+(?=[A-Z\p{Lu}])|$)/u.exec(oneLine)?.[1] ?? oneLine;
  const candidate = sentence.replace(/`/g, "").replace(/[.:;,\s]+$/, "");
  if (candidate.length <= SUBJECT_MAX) {
    return candidate;
  }
  const cut = candidate.slice(0, SUBJECT_MAX);
  const atWord = cut.lastIndexOf(" ");
  return (atWord > SUBJECT_MAX / 2 ? cut.slice(0, atWord) : cut).replace(/[.:;,\s]+$/, "");
}

/** Subject line, then the whole text when the subject did not carry it all. */
export function foldMessageOf(text: string): string {
  const subject = subjectOf(text);
  const whole = text.trim();
  return subject === whole || subject === whole.replace(/[.\s]+$/, "")
    ? subject
    : `${subject}\n\n${whole}`;
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
  const maxRefusals = options.maxRefusals ?? DEFAULT_MAX_REFUSALS;
  const assemblyValidate = options.assemblyValidate ?? false;
  const assemblyFixDeclared = options.assemblyFixDeclared ?? false;
  const warm = options.warm;
  /** Features whose warm already succeeded in this Conductor instance. */
  const warmed = new Set<string>();
  let paused = false;

  const refused = (code: ConductorRefusalCode): ProjectRunResult => ({
    outcome: "refused",
    code,
  });

  /** What the last Attempt ended on, for whoever reads the escalation. */
  const reasonOfTraces = (traces: ImplementTrace[]): string | undefined => {
    const last = traces.at(-1);
    const report = last?.report?.trim();
    if (report === undefined || report.length === 0) {
      return undefined;
    }
    return last?.refusedBy === undefined ? report : `${last.refusedBy}: ${report}`;
  };

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
   * Freeze the Feature for a human. If a newer fingerprint arrived in flight,
   * it is named on the escalation and consumed by the ledger.
   */
  async function freeze(
    key: string,
    input: { kind: EscalationKind; subtaskId?: string; report?: string },
  ): Promise<ProjectRunResult> {
    const got = await ledger.get(key);
    const pending =
      got.ok && got.aggregate.pending_fingerprint !== undefined
        ? `The intention was edited while the work was in flight (now fingerprint ${got.aggregate.pending_fingerprint}). The work stops here for a human to decide: on resume it is planned again from the new words, and what already landed is kept.`
        : undefined;
    const report = [input.report, pending]
      .filter((part): part is string => part !== undefined && part.length > 0)
      .join(" ");
    const escalated = await ledger.escalate({
      key,
      kind: input.kind,
      ...(input.subtaskId === undefined ? {} : { subtaskId: input.subtaskId }),
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
    return await freeze(key, { kind: "plan" });
  }

  async function expireIfHeld(key: string): Promise<void> {
    const expired = await ledger.expireBail(key);
    if (expired.ok) {
      const got = await ledger.get(key);
      if (got.ok && got.aggregate.workspaces?.subtask !== undefined) {
        await destroy(got.aggregate.workspaces.subtask);
      }
    }
  }

  /**
   * A Subtask was started and a transformer stopped on interrupt. Release the
   * bail now so the next process does not wait an hour for the clock.
   */
  async function releaseHeldAfterInterrupt(key: string): Promise<ProjectRunResult | undefined> {
    const before = await ledger.get(key);
    const child = before.ok ? before.aggregate.workspaces?.subtask : undefined;
    const released = await ledger.releaseBail(key);
    if (!released.ok) {
      if (released.code === "persist-failed") {
        return refused("persist-failed");
      }
      // Already free, or a state releaseBail refuses — leave the ledger and
      // still answer interrupted.
      return undefined;
    }
    if (child !== undefined) {
      await destroy(child);
    }
    return undefined;
  }

  async function reconcile(project: string): Promise<void> {
    const declared = await ledger.listDeclaredWorkspaces();
    const allowed = new Set<string>();
    for (const row of declared) {
      if (row.feature !== undefined) {
        allowed.add(resolve(row.feature));
      }
      if (row.subtask !== undefined) {
        allowed.add(resolve(row.subtask));
      }
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
    const feature = got.aggregate.workspaces?.feature;
    const subtask = got.aggregate.workspaces?.subtask;
    if (subtask !== undefined) {
      await destroy(subtask);
    }
    if (feature !== undefined) {
      await destroy(feature);
    }
    await ledger.clearWorkspace({ key, feature: true, subtask: true });
  }

  async function ensureFeatureIsolated(key: string): Promise<ProjectRunResult | undefined> {
    const got = await ledger.get(key);
    if (!got.ok) {
      return refused("not-found");
    }
    const child = declaredFeaturePath(workspaceRoot, key, got.aggregate);
    if (got.aggregate.workspaces?.feature === undefined) {
      const declared = await ledger.declareWorkspace({ key, feature: child });
      const failure = fromLedger(declared);
      if (failure !== undefined) {
        return failure;
      }
    }
    let fresh = false;
    if (!existsSync(child)) {
      if (got.aggregate.submission !== undefined) {
        // The Authority is holding a Submission built from a workspace that is no
        // longer here. Isolating again would rebuild the feature from the work
        // line and publish it over that Submission, which would drop whatever the
        // Authority has already been shown. That is a human's call, not this
        // loop's.
        const escalated = await freeze(key, { kind: "submitted" });
        return escalated;
      }
      const isolated = await transformers.isolate({
        id: key,
        context: key,
        parent: workLineStable,
        child,
        durationMs,
      });
      if (isolated.outcome === "interrupted") {
        return refused("interrupted");
      }
      if (isolated.outcome !== "isolated") {
        return refused(
          isolated.outcome === "invalid-invocation" ? "transformer-invalid" : "isolate-failed",
        );
      }
      fresh = true;
      warmed.delete(key);
    }
    if (warm !== undefined && (fresh || !warmed.has(key))) {
      const prepared = await warm.prepare({
        workspace: child,
        durationMs: warm.durationMs,
      });
      if (prepared.outcome === "interrupted") {
        return refused("interrupted");
      }
      if (prepared.outcome === "invalid-invocation") {
        return refused("transformer-invalid");
      }
      if (prepared.outcome !== "warmed") {
        return refused("warm-failed");
      }
      warmed.add(key);
    }
    return undefined;
  }

  async function doPlan(key: string): Promise<DriveResult> {
    const got = await ledger.get(key);
    if (!got.ok) {
      return refused("not-found");
    }
    if (got.aggregate.state !== "planning") {
      return undefined;
    }
    const broken = await transformers.breakDown({
      featureJson: featureJsonOf(got.aggregate.intention),
    });
    if (broken.outcome === "refused") {
      const recorded = await ledger.refusePlan({
        key,
        code: broken.code,
        reason: broken.reason,
      });
      const failure = fromLedger(recorded);
      if (failure !== undefined) {
        return failure;
      }
      return { outcome: "escalated", key };
    }
    if (broken.outcome === "interrupted") {
      return refused("interrupted");
    }
    if (broken.outcome === "unavailable") {
      return refused("unavailable");
    }
    if (broken.outcome !== "planned") {
      return refused("transformer-invalid");
    }
    const recorded = await ledger.recordPlan({
      key,
      plannedAt: broken.plannedAt,
      subtasks: broken.subtasks,
    });
    const recordFail = fromLedger(recorded);
    if (recordFail !== undefined) {
      return recordFail;
    }
    await observe({ kind: "planned", key });
    return undefined;
  }

  async function runOneSubtask(key: string, subtaskId: string): Promise<DriveResult> {
    const before = await ledger.get(key);
    const started = await ledger.startSubtask({ key, subtaskId });
    const startFail = fromLedger(started);
    if (startFail !== undefined) {
      return startFail;
    }
    const child = subtaskWorkspacePath(workspaceRoot, key, subtaskId);
    // Resume from zero: Isolator refuses an existing Child. A kept one may sit
    // where an earlier layout put it; it goes too, or its branch stays taken.
    const kept = before.ok ? before.aggregate.workspaces?.subtask : undefined;
    for (const path of new Set([child, ...(kept === undefined ? [] : [kept])])) {
      if (existsSync(path)) {
        await destroy(path);
      }
    }
    const declared = await ledger.declareWorkspace({ key, subtask: child });
    const declareFail = fromLedger(declared);
    if (declareFail !== undefined) {
      return declareFail;
    }
    const featureNow = await ledger.get(key);
    const parent = declaredFeaturePath(
      workspaceRoot,
      key,
      featureNow.ok ? featureNow.aggregate : undefined,
    );
    const isolated = await transformers.isolate({
      // Scoped to the feature: a Subtask id is unique inside its plan and
      // nowhere else, so "A" alone would name every feature's first Subtask.
      id: `${key}:${subtaskId}`,
      context: key,
      parent,
      child,
      durationMs,
    });
    if (isolated.outcome === "interrupted") {
      const failure = await releaseHeldAfterInterrupt(key);
      return failure ?? refused("interrupted");
    }
    if (isolated.outcome !== "isolated") {
      return refused(
        isolated.outcome === "invalid-invocation" ? "transformer-invalid" : "isolate-failed",
      );
    }
    const got = await ledger.get(key);
    if (!got.ok) {
      return refused("not-found");
    }
    const subtask = got.aggregate.plan?.subtasks.find((st) => st.id === subtaskId);
    if (subtask === undefined) {
      return refused("not-found");
    }
    const implemented = await transformers.implement({
      id: subtaskId,
      context: key,
      intention: subtask.intention,
      definitionOfDone: subtask.definition_of_done,
      workspace: child,
    });
    if (implemented.outcome === "interrupted") {
      const failure = await releaseHeldAfterInterrupt(key);
      return failure ?? refused("interrupted");
    }
    if (implemented.outcome === "invalid-invocation") {
      return refused("transformer-invalid");
    }
    let number = got.aggregate.attempts.filter((a) => a.subtask_id === subtaskId).length + 1;
    for (const trace of implemented.traces) {
      const recorded = await ledger.recordAttempt({
        key,
        subtaskId,
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
        kind: "subtask",
        subtaskId,
        ...(why === undefined ? {} : { report: why }),
      });
    }
    const folded = await transformers.integrate({
      id: subtaskId,
      context: key,
      parent,
      child,
      durationMs,
      // What carries the work into the feature says what the work was.
      subject: foldMessageOf(subtask.intention),
      mergeSubject: `Merge ${subtaskId} into the feature`,
    });
    if (folded.outcome === "interrupted") {
      const failure = await releaseHeldAfterInterrupt(key);
      return failure ?? refused("interrupted");
    }
    if (folded.outcome === "conflict") {
      // The unit passed its Gates; what stopped it is the fold, which leaves
      // no trace of its own. Said here, or the escalation says nothing.
      return await freeze(key, {
        kind: "subtask",
        subtaskId,
        report: `Folding ${subtaskId} into the feature hit a conflict.`,
      });
    }
    if (folded.outcome !== "integrated") {
      return refused("transformer-invalid");
    }
    const marked = await ledger.markSubtaskIntegrated({ key, subtaskId });
    const markFail = fromLedger(marked);
    if (markFail !== undefined) {
      return markFail;
    }
    await destroy(child);
    await ledger.clearWorkspace({ key, subtask: true });
    const after = await ledger.get(key);
    if (after.ok && after.aggregate.plan !== undefined) {
      const subtasks = after.aggregate.plan.subtasks;
      await observe({
        kind: "subtask-integrated",
        key,
        subtaskId,
        integrated: subtasks.filter((subtask) => subtask.state === "integrated").length,
        total: subtasks.length,
      });
    }
    return await freezeIfPending(key);
  }

  async function doRunning(key: string): Promise<DriveResult> {
    const isolated = await ensureFeatureIsolated(key);
    if (isolated !== undefined) {
      return isolated;
    }
    while (!paused) {
      const next = await ledger.nextRunnable(key);
      if (next === undefined) {
        break;
      }
      const step = await runOneSubtask(key, next);
      if (step !== undefined) {
        return step;
      }
    }
    if (paused) {
      return { outcome: "paused", key };
    }
    return undefined;
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
    const featurePath = declaredFeaturePath(workspaceRoot, key, got.aggregate);
    // A parked refusal is this round's; a Submission's is carried forward on
    // purpose and may already be repaired. The fresher one wins.
    const parked = got.aggregate.parked_refusal;
    const sentBack = parked?.report ?? got.aggregate.submission?.last_report;
    if (sentBack !== undefined) {
      // Something refused the last round and said why. That report is the only
      // reason this stage has to produce: the Subtasks are already validated.
      //
      // Before the Integration below, and that order is the whole point. What a
      // producer leaves is loose in the workspace; the Integration is the only
      // thing that takes it up. Producing after it means the repair waits for
      // the next round to be taken up at all, and what goes out meanwhile is the
      // state that was already refused — the same refusal comes back, and the
      // budget empties on the delay.
      const refusedBy = parked?.refused_by ?? got.aggregate.submission?.last_refused_by;
      const remade = await transformers.implement({
        id: `${key}:assembly`,
        context: key,
        stage: "assembly",
        produce: true,
        intention: got.aggregate.intention.intention,
        workspace: featurePath,
        report: sentBack,
        ...(refusedBy === undefined ? {} : { reportFrom: refusedBy }),
      });
      if (remade.outcome === "interrupted") {
        return refused("interrupted");
      }
      if (remade.outcome === "invalid-invocation") {
        return refused("transformer-invalid");
      }
      if (remade.outcome === "escalated") {
        // The whole, not one of its parts: naming a Subtask here sends a reader
        // to look at work that did not fail.
        const why = reasonOfTraces(remade.traces);
        return await freeze(key, {
          kind: "assembly",
          ...(why === undefined ? {} : { report: why }),
        });
      }
    }
    const aligned = await transformers.integrate({
      id: `${key}:align`,
      context: key,
      parent: featurePath,
      child: workLineStable,
      durationMs,
      // What is loose in the feature workspace here is a repair, if anything.
      subject:
        sentBack === undefined
          ? `Align with ${workLineTarget || "the work line"}`
          : "Repair after it was refused",
      mergeSubject: `Merge ${workLineTarget || "the work line"} into the feature`,
    });
    if (aligned.outcome === "interrupted") {
      return refused("interrupted");
    }
    if (aligned.outcome === "conflict") {
      return refused("align-conflict");
    }
    if (aligned.outcome !== "integrated") {
      return refused("transformer-invalid");
    }
    if (paused) {
      return { outcome: "paused", key };
    }
    if (assemblyValidate) {
      const validated = await transformers.implement({
        id: `${key}:validate`,
        context: key,
        stage: "assembly",
        validate: true,
        intention: got.aggregate.intention.intention,
        workspace: featurePath,
      });
      if (validated.outcome === "interrupted") {
        return refused("interrupted");
      }
      if (validated.outcome === "invalid-invocation") {
        return refused("transformer-invalid");
      }
      if (validated.outcome === "escalated") {
        const last = validated.traces.at(-1);
        const report = last?.report ?? "The assembled feature was refused, with no reason given.";
        const spent =
          (got.aggregate.submission?.refusals ?? 0) + (got.aggregate.parked_refusals ?? 0);
        const canRepair =
          assemblyFixDeclared && last?.ended !== "fail-blocking" && spent + 1 < maxRefusals;
        if (!canRepair) {
          return await freeze(key, {
            kind: "assembly",
            report: last?.refusedBy === undefined ? report : `${last.refusedBy}: ${report}`,
          });
        }
        const recorded = await ledger.recordParkedRefusal({
          key,
          report,
          ...(last?.refusedBy === undefined ? {} : { refusedBy: last.refusedBy }),
        });
        const failure = fromLedger(recorded);
        if (failure !== undefined) {
          return failure;
        }
        // Repair is on its way: do not offer, or judge, work that is already
        // known to need it.
        return { outcome: "paused", key };
      }
      const cleared = await ledger.clearParkedRefusal(key);
      const clearFail = fromLedger(cleared);
      if (clearFail !== undefined) {
        return clearFail;
      }
    }
    if (authority === undefined) {
      // Nobody outside will look at it, so the Project's own sequence is the
      // only judgement the assembled feature gets. Skipping it here would let
      // work into the work line that nothing ever judged as a whole.
      const judged = await judge(key, got.aggregate);
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
   * Put the assembled feature in front of the Authority.
   *
   * A feature already submitted is offered again rather than a second time:
   * the work was published to the same place, so the Authority is judging the
   * same Submission with new content.
   */
  async function offer(key: string, aggregate: FeatureAggregate): Promise<ProjectRunResult> {
    if (authority === undefined) {
      return refused("transformer-invalid");
    }
    const title = aggregate.intention.title;
    const intention = aggregate.intention.intention;
    const steps = aggregate.plan?.subtasks.map((subtask) => subtask.intention) ?? [];
    const submitted = await authority.submit({
      key,
      project: aggregate.intention.project,
      ref: key,
      target: workLineTarget,
      workspace: declaredFeaturePath(workspaceRoot, key, aggregate),
      ...(title === undefined ? {} : { title }),
      ...(intention === undefined ? {} : { intention }),
      ...(steps.length === 0 ? {} : { steps }),
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

  /**
   * Judge the assembled feature with the Project's Gate sequence for it.
   *
   * Nothing is produced: the work is done, and this pass only decides whether it
   * may enter the work line. A Gate that reads an outside answer belongs in that
   * sequence like any other — it says ok or not, and it does not act.
   */
  async function judge(key: string, aggregate: FeatureAggregate): Promise<ImplementResult> {
    return await transformers.implement({
      id: `${key}:judgement`,
      context: key,
      stage: "assembly",
      produce: false,
      intention: aggregate.intention.intention,
      workspace: declaredFeaturePath(workspaceRoot, key, aggregate),
    });
  }

  async function doSubmitted(key: string): Promise<ProjectRunResult> {
    const got = await ledger.get(key);
    if (!got.ok) {
      return refused("not-found");
    }
    const submission = got.aggregate.submission;
    if (authority === undefined || submission === undefined) {
      return refused("transformer-invalid");
    }
    const featurePath = declaredFeaturePath(workspaceRoot, key, got.aggregate);
    const judged = await judge(key, got.aggregate);
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
      if (last?.ended === "fail-blocking" || submission.refusals + 1 >= maxRefusals) {
        // The refusal that stopped it is never recorded as one — this is the
        // only place it can be kept for the person who reads the escalation.
        return await freeze(key, {
          kind: "submitted",
          report: last?.refusedBy === undefined ? report : `${last.refusedBy}: ${report}`,
        });
      }
      const recorded = await ledger.recordRefusal({
        key,
        report,
        ...(last?.refusedBy === undefined ? {} : { refusedBy: last.refusedBy }),
      });
      const failure = fromLedger(recorded);
      if (failure !== undefined) {
        return failure;
      }
      // Back to where the work is made. The next pass produces with that report
      // in hand and publishes to the same place.
      return { outcome: "paused", key };
    }

    const folded = await authority.fold({ reference: submission.reference });
    if (folded.outcome === "unavailable") {
      return { outcome: "paused", key };
    }
    if (folded.outcome === "conflict") {
      return await freeze(key, { kind: "submitted" });
    }
    // The Authority folded it. The work line moved; this system's copy has not,
    // and whoever wired the Authority is the one that brings it up to date.
    const merging = await ledger.markMerging(key);
    const mergingFailure = fromLedger(merging);
    if (mergingFailure !== undefined) {
      return mergingFailure;
    }
    const done = await ledger.markDone(key, { reference: folded.reference });
    const doneFailure = fromLedger(done);
    if (doneFailure !== undefined) {
      return doneFailure;
    }
    await destroy(featurePath);
    await ledger.clearWorkspace({ key, feature: true, subtask: true });
    return { outcome: "done", key };
  }

  async function doMerging(key: string): Promise<ProjectRunResult> {
    const got = await ledger.get(key);
    const featurePath = declaredFeaturePath(workspaceRoot, key, got.ok ? got.aggregate : undefined);
    const title = got.ok
      ? (got.aggregate.intention.title ?? got.aggregate.intention.intention)
      : key;
    const folded = await transformers.integrate({
      id: key,
      context: key,
      parent: workLineStable,
      child: featurePath,
      durationMs,
      subject: foldMessageOf(title),
      mergeSubject: `Merge ${subjectOf(title)}`,
    });
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
    await destroy(featurePath);
    await ledger.clearWorkspace({ key, feature: true, subtask: true });
    return { outcome: "done", key };
  }

  async function drive(key: string): Promise<ProjectRunResult> {
    const planResult = await doPlan(key);
    if (planResult !== undefined) {
      return planResult;
    }
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
      const claimed = await ledger.claim(project);
      if (!claimed.ok) {
        const failure = fromLedger(claimed);
        return failure ?? refused("illegal-transition");
      }
      if ("empty" in claimed) {
        return { outcome: "idle" };
      }
      return await drive(claimed.key);
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
      const child = before.ok ? before.aggregate.workspaces?.subtask : undefined;
      const released = await ledger.releaseBail(key);
      if (released.ok && child !== undefined) {
        await destroy(child);
      }
      return released;
    },
  };
}
