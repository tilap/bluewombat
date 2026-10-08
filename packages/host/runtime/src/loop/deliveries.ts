import type { ProjectRunResult } from "@bluewombat/conductor";
import type { FeatureStandard } from "@bluewombat/manager-kit";
import type { FeatureAdmission, FeatureState } from "@bluewombat/work-ledger";
import type { HostDeliveryInput, HostRunInput } from "./context.js";
import { driveUntilBlocked } from "./drive.js";
import { pushReport, resumePointOf } from "./report.js";

/**
 * An upsert leaves Features that ready / cancel / too-late already own.
 * SPECS §6: leave in-flight / terminal (including submitted); do not restart.
 * The ledger still records a *new* fingerprint as pending_fingerprint; Host
 * does not admit here, so an echo of Submitted cannot look like one.
 */
const IN_FLIGHT_OR_TERMINAL: ReadonlySet<FeatureState> = new Set([
  "planning",
  "running",
  "escalated",
  "integrating",
  "submitted",
  "merging",
  "done",
  "cancelled",
]);

export async function handleDelivery(
  input: HostDeliveryInput & { payload: Record<string, unknown> },
): Promise<{ advance: boolean; run?: ProjectRunResult; project?: string }> {
  const adapted = await input.manager.adapt(input.payload);
  switch (adapted.outcome) {
    case "unavailable":
    case "interrupted":
      return { advance: false };
    case "invalid": {
      // Telling the tracker writes to it, and that write delivers the same
      // intention again. What a human wrote has not changed: said once.
      const before = await input.ledger.get(adapted.key);
      if (
        before.ok &&
        before.aggregate.state === "invalid" &&
        before.aggregate.intention.fingerprint === adapted.fingerprint
      ) {
        input.journal.append({ event: "skipped", key: adapted.key, state: "invalid" });
        return { advance: true };
      }
      await input.ledger.recordInvalid({
        key: adapted.key,
        project: adapted.project,
        code: adapted.invalid.code,
        reason: adapted.invalid.reason,
        fingerprint: adapted.fingerprint,
      });
      input.journal.append({
        event: "invalid",
        key: adapted.key,
        reason: adapted.invalid.reason,
      });
      await pushReport(input, {
        event: "invalid",
        key: adapted.key,
        project: adapted.project,
        // One per intention as written: an edit is a new fingerprint and is said again.
        eventId: `${adapted.key}:invalid:${adapted.fingerprint}`,
        fields: { reason: adapted.invalid.reason },
      });
      return { advance: true };
    }
    case "converted":
      break;
  }

  const feature = adapted.feature;
  // Poll snapshots have no labeled edge: a ready signal on an escalated upsert
  // is the same instruction as an explicit ready intent.
  if (feature.intent === "upsert" && input.manager.signalsReady?.(input.payload) === true) {
    const before = await input.ledger.get(feature.key);
    if (before.ok && before.aggregate.state === "escalated") {
      return await handleReady(feature, input);
    }
  }
  switch (feature.intent) {
    case "ready":
      return await handleReady(feature, input);
    case "cancel":
      await handleCancel(feature, input);
      return { advance: true };
    case "upsert":
      return await handleUpsert(feature, input);
  }
}

async function handleUpsert(
  feature: FeatureStandard,
  input: HostDeliveryInput,
): Promise<{ advance: boolean; run?: ProjectRunResult; project?: string }> {
  const admission = toAdmission(feature);
  if (admission === undefined) {
    return { advance: true };
  }
  const before = await input.ledger.get(admission.key);
  if (before.ok && IN_FLIGHT_OR_TERMINAL.has(before.aggregate.state)) {
    input.journal.append({
      event: "skipped",
      key: admission.key,
      state: before.aggregate.state,
    });
    return { advance: true };
  }
  const admitted = await input.ledger.admit(admission);
  if (!admitted.ok) {
    if (admitted.code === "too-late" || admitted.code === "point-of-no-return") {
      await pushReport(input, {
        event: "reject_late",
        key: admission.key,
        project: admission.project,
        // One per intention: the same edit delivered again is the echo of
        // this report, not another edit.
        eventId: `${admission.key}:reject_late:${admission.fingerprint}`,
        fields: { reason: `Admission refused: ${admitted.code}` },
      });
    }
    return { advance: true };
  }
  if (!before.ok || before.aggregate.state === "invalid") {
    input.journal.append({ event: "admitted", key: admission.key, project: admission.project });
    await pushReport(input, {
      event: "accepted",
      key: admission.key,
      project: admission.project,
      // One per intention as written, like `invalid`: a corrected issue is accepted again.
      eventId: `${admission.key}:accepted:${admission.fingerprint}`,
      fields: { priority: admission.priority },
    });
  }
  const run = await driveUntilBlocked(input, admission.project, admission.key);
  if (run === undefined) {
    // Frozen Project: do not mark it driven, so a later delivery in this pass
    // (a cancel, a ready) can free it and the sweep can start the queue.
    return { advance: true };
  }
  return { advance: true, run, project: admission.project };
}

async function handleReady(
  feature: FeatureStandard,
  input: HostDeliveryInput,
): Promise<{ advance: boolean; run?: ProjectRunResult; project?: string }> {
  const before = await input.ledger.get(feature.key);
  if (!before.ok || before.aggregate.state !== "escalated") {
    return { advance: true };
  }
  const resumePoint = resumePointOf(before.aggregate);
  const ready = await input.ledger.resumeReady(feature.key);
  if (!ready.ok) {
    return { advance: true };
  }
  // The signal is an instruction, not a state: left where it is, it resumes the
  // feature again on every pass and an escalation never freezes anything.
  await input.manager.clearReady?.(feature.key);
  // The ledger counts the rounds; this resume is the latest one.
  const resumed = await input.ledger.get(feature.key);
  const round = resumed.ok ? (resumed.aggregate.resumes ?? 0) : 0;
  await pushReport(input, {
    event: "resumed",
    key: feature.key,
    project: feature.project,
    eventId: `${feature.key}:resumed:${round}`,
    fields: { resume_point: resumePoint },
  });
  const run = await driveUntilBlocked(input, feature.project, feature.key);
  if (run === undefined) {
    return { advance: true };
  }
  return { advance: true, run, project: feature.project };
}

export async function handleCancel(
  feature: { key: string; project: string },
  input: HostDeliveryInput,
): Promise<void> {
  const before = await input.ledger.get(feature.key);
  if (!before.ok) {
    return;
  }
  const state = before.aggregate.state;
  if (state === "cancelled") {
    // The ledger takes a second cancel as done already; the tracker was told
    // the first time, and that is what delivered this one.
    return;
  }
  if (state === "done") {
    // A finished feature's issue closing is the tracker agreeing, not a
    // cancel arriving late — the Submission itself asked for that close.
    input.journal.append({ event: "skipped", key: feature.key, state });
    return;
  }
  const cancelled = await input.conductor.cancel(feature.key);
  if (!cancelled.ok) {
    if (cancelled.code === "point-of-no-return") {
      await pushReport(input, {
        event: "reject_late",
        key: feature.key,
        project: feature.project,
        // A closed issue stays closed: every later delivery is the same cancel.
        eventId: `${feature.key}:reject_late:cancel`,
        fields: { reason: "Cancel arrived after the point of no return." },
      });
    }
    return;
  }
  await pushReport(input, {
    event: "cancelled",
    key: feature.key,
    project: feature.project,
    // A Feature is cancelled once: the ledger refuses a second cancel and never re-admits the key.
    eventId: `${feature.key}:cancelled`,
    fields: { state },
  });
}

export type CancelResult =
  | { ok: true }
  | {
    ok: false;
    code: "not-found" | "point-of-no-return" | "already-cancelled" | "done";
  };

export type ReleaseResult =
  | { ok: true; freed: boolean }
  | {
    ok: false;
    code: "not-found" | "illegal-transition";
    state?: string;
  };

/**
 * Drop a held Subtask (or planning) by key — without waiting for the bail clock.
 *
 * `freed` is false when the Feature was already free (running with no Subtask
 * held). Refused past `planning` / `running`: those states resume without a
 * held Subtask, or are past the point a local release can undo.
 */
export async function releaseFeature(input: HostRunInput, key: string): Promise<ReleaseResult> {
  const got = await input.ledger.get(key);
  if (!got.ok) {
    return { ok: false, code: "not-found" };
  }
  const { aggregate } = got;
  const held =
    aggregate.state === "planning" ||
    (aggregate.state === "running" &&
      (aggregate.plan?.subtasks.some((subtask) => subtask.state === "running") ?? false));
  const released = await input.conductor.release(key);
  if (!released.ok) {
    if (released.code === "not-found") {
      return { ok: false, code: "not-found" };
    }
    return { ok: false, code: "illegal-transition", state: aggregate.state };
  }
  return { ok: true, freed: held };
}

/** Abandon one Feature by key — the same path a `cancel` delivery takes. */
export async function cancelFeature(input: HostRunInput, key: string): Promise<CancelResult> {
  const got = await input.ledger.get(key);
  if (!got.ok) {
    return { ok: false, code: "not-found" };
  }
  const state = got.aggregate.state;
  if (state === "cancelled") {
    return { ok: false, code: "already-cancelled" };
  }
  if (state === "done") {
    return { ok: false, code: "done" };
  }
  await handleCancel({ key, project: got.aggregate.intention.project }, { ...input, reported: [] });
  const after = await input.ledger.get(key);
  if (after.ok && after.aggregate.state === "cancelled") {
    return { ok: true };
  }
  return { ok: false, code: "point-of-no-return" };
}

function toAdmission(feature: FeatureStandard): FeatureAdmission | undefined {
  if (feature.intent !== "upsert") {
    return undefined;
  }
  if (feature.intention === undefined) {
    return undefined;
  }
  const admission: FeatureAdmission = {
    key: feature.key,
    project: feature.project,
    fingerprint: feature.fingerprint,
    priority: feature.priority,
    intention: feature.intention,
    manager: feature.manager,
    external_id: feature.external_id,
  };
  if (feature.title !== undefined) {
    admission.title = feature.title;
  }
  if (feature.source !== undefined) {
    admission.source = feature.source;
  }
  return admission;
}
