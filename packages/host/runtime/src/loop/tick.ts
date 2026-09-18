import type { Conductor, ProjectRunResult } from "@bluewombat/conductor";
import type { EventName } from "@bluewombat/manager-kit";
import type { FeatureState, FeatureSummary, WorkLedger } from "@bluewombat/work-ledger";
import { refreshWorkLine } from "./authority.js";
import type { HostRunInput } from "./context.js";
import { loadCursor, saveCursor } from "./cursor.js";
import { type CancelResult, handleDelivery } from "./deliveries.js";
import { driveUntilBlocked } from "./drive.js";
import { abandonGone } from "./probe.js";
import { reportMoment } from "./report.js";

/**
 * States the sweep will try to drive. `escalated` is frozen for a human;
 * `received` is the queue that nothing else starts once the tracker goes quiet.
 */
const SWEEP_STATES: ReadonlySet<FeatureState> = new Set([
  "received",
  "planning",
  "running",
  "integrating",
  "submitted",
]);

export type HostTickResult = {
  listenerOutcome: string;
  reported: EventName[];
  lastRun?: ProjectRunResult;
  cursor?: string;
};

export type Host = {
  ledger: WorkLedger;
  conductor: Conductor;
  runOnce(): Promise<HostTickResult>;
  run(): Promise<HostTickResult>;
  /** Abandon one Feature by key. Takes the same path as a `cancel` delivery. */
  cancel(key: string): Promise<CancelResult>;
  /** Give the ledger back: the lock `openHost` took. */
  close(): Promise<void>;
};

export async function runOnce(input: HostRunInput): Promise<HostTickResult> {
  const { options, workLine, ledger, manager, journal, trace, authority } = input;
  const interruptFlag = options.interruptFlag ?? { interrupted: false };

  const reported: EventName[] = [];
  let lastRun: ProjectRunResult | undefined;
  // Projects a delivery already drove this pass. Driving one twice is not
  // wrong, it just does two steps where the caller asked for one.
  const driven = new Set<string>();
  const since = await loadCursor(options.ledgerRoot);
  const listenInput: { since?: string } = {};
  if (since !== undefined) {
    listenInput.since = since;
  }
  const listened = await manager.listen(listenInput);
  journal.append({
    event: "listen",
    outcome: listened.outcome,
    deliveries: listened.deliveries.length,
  });
  if (listened.deliveries.length > 0) {
    trace(`listen     ${listened.deliveries.length} to look at`);
  }

  const deliveryInput = { ...input, reported };
  const probed = await abandonGone(deliveryInput, listened.outcome);
  if (probed === "stop") {
    return { listenerOutcome: listened.outcome, reported };
  }

  // The work line copy is brought up to date before anything is driven on it
  // — and only then: a pass with nothing to drive fetches nothing. Starting
  // work on a copy that could not be brought up to date builds on a version
  // that no longer exists, so a failed refresh drives nothing; the next pass
  // tries again, and a human can look at that tree meanwhile.
  const pendingBefore = await pendingWork(ledger);
  const somethingToDrive = listened.deliveries.length > 0 || pendingBefore.length > 0;
  if (somethingToDrive && authority !== undefined && workLine.target !== undefined) {
    const refreshed = refreshWorkLine({
      workLineStable: workLine.stable,
      workLineTarget: workLine.target,
      refreshArgv: options.authority?.refreshArgv ?? [],
      timeoutMs: options.timeoutMs,
      env: workLine.env,
    });
    if (!refreshed.ok) {
      journal.append({
        event: "refresh",
        outcome: "failed",
        target: workLine.target,
        ...(refreshed.detail === undefined ? {} : { detail: refreshed.detail }),
      });
      trace(
        `work line  cannot fast-forward onto ${workLine.target}, so nothing started. ${refreshed.detail ?? ""}`,
      );
      return { listenerOutcome: "skipped", reported };
    }
    journal.append({ event: "refresh", outcome: "ok", target: workLine.target });
  }

  // What Conductor says mid-pass is reported as it happens, not after the pass:
  // a plan, a Subtask landed, a Submission — each is something a person waits for.
  input.watcher.current = (moment) => reportMoment(deliveryInput, moment);
  let cursor = since;
  for (const delivery of listened.deliveries) {
    if (interruptFlag.interrupted) {
      break;
    }
    const handled = await handleDelivery({
      ...deliveryInput,
      payload: delivery.payload,
    });
    if (!handled.advance) {
      break;
    }
    if (handled.run !== undefined) {
      lastRun = handled.run;
    }
    if (handled.project !== undefined) {
      driven.add(handled.project);
    }
    cursor = delivery.cursor;
    await saveCursor(options.ledgerRoot, delivery.cursor);
  }

  // A Project with work in flight, or a Feature still `received` behind one,
  // moves on whether or not the tracker mentioned it again. Nothing else
  // claims a queue, so a restart with only `received` work would otherwise
  // sit idle until a delivery that has no reason to come.
  const pending = await pendingWork(ledger);
  if (pending.length > 0) {
    journal.append({
      event: "sweep",
      keys: pending.map((summary) => summary.key),
    });
  }
  for (const summary of pending) {
    if (interruptFlag.interrupted || driven.has(summary.project)) {
      continue;
    }
    driven.add(summary.project);
    const run = await driveUntilBlocked(deliveryInput, summary.project, summary.key);
    if (run !== undefined) {
      lastRun = run;
    }
  }

  if (listened.deliveries.length === 0 && pending.length === 0) {
    journal.append({ event: "idle" });
  }

  const result: HostTickResult = {
    listenerOutcome: listened.outcome,
    reported,
  };
  if (lastRun !== undefined) {
    result.lastRun = lastRun;
  }
  if (cursor !== undefined) {
    result.cursor = cursor;
  }
  return result;
}

export async function run(input: HostRunInput): Promise<HostTickResult> {
  const { options, conductor, journal } = input;
  const interruptFlag = options.interruptFlag ?? { interrupted: false };
  let last: HostTickResult = {
    listenerOutcome: "completed",
    reported: [],
  };
  for (;;) {
    if (interruptFlag.interrupted) {
      journal.append({ event: "paused" });
      conductor.pause();
      return last;
    }
    last = await runOnce(input);
    if (options.pollIntervalMs === undefined) {
      return last;
    }
    await sleep(options.pollIntervalMs, interruptFlag);
  }
}

async function pendingWork(ledger: WorkLedger): Promise<FeatureSummary[]> {
  const summaries = await ledger.list();
  return summaries.filter((summary) => SWEEP_STATES.has(summary.state));
}

function sleep(ms: number, interruptFlag: { interrupted: boolean }): Promise<void> {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = (): void => {
      if (interruptFlag.interrupted || Date.now() - started >= ms) {
        resolve();
        return;
      }
      setTimeout(tick, Math.min(50, ms));
    };
    tick();
  });
}
