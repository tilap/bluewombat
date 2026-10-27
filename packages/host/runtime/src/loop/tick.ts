import type { Conductor, ProjectRunResult } from "@bluewombat/conductor";
import type { EventName } from "@bluewombat/manager-kit";
import type { FeatureState, WorkLedger } from "@bluewombat/work-ledger";
import type { HostRunInput } from "./context.js";
import { loadCursor, saveCursor } from "./cursor.js";
import type { CancelResult, ReleaseResult } from "./deliveries.js";
import type { RestartResult } from "./features.js";
import { advanceProject, handleFeatureDelivery } from "./features.js";
import { abandonGone } from "./probe.js";
import { reportMoment } from "./report.js";

/** Features that still have something to do: the Projects the sweep moves along. */
const SWEEP_STATES: ReadonlySet<FeatureState> = new Set(["waiting", "open", "submitted"]);

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
  /** Abandon one Feature or Ticket by key. Takes the same path as a `cancel` delivery. */
  cancel(key: string): Promise<CancelResult>;
  /** Resume an escalated Feature with a fresh workspace, made again from its line. */
  restart(key: string): Promise<RestartResult>;
  /** Drop a held unit without waiting for the bail clock. */
  release(key: string): Promise<ReleaseResult>;
  /** Give the ledger back: the lock `openHost` took. */
  close(): Promise<void>;
};

export async function runOnce(input: HostRunInput): Promise<HostTickResult> {
  const { options, ledger, features, journal, trace } = input;
  const interruptFlag = options.interruptFlag ?? { interrupted: false };

  const reported: EventName[] = [];
  let lastRun: ProjectRunResult | undefined;
  const since = await loadCursor(options.ledgerRoot);
  const listenInput: { since?: string } = {};
  if (since !== undefined) {
    listenInput.since = since;
  }
  const listened = await features.listen(listenInput);
  journal.append({
    event: "listen",
    outcome: listened.outcome,
    deliveries: listened.deliveries.length,
  });
  if (listened.deliveries.length > 0) {
    trace(`listen     ${listened.deliveries.length} to look at`);
  }
  // A tracker that cannot be read is the one thing a quiet loop must not hide:
  // it is repeated on every poll until it answers again.
  if (listened.outcome === "source-lost" || listened.outcome === "invalid-invocation") {
    trace(`listen     ${listened.outcome}: the tracker could not be read`);
  }

  const deliveryInput = { ...input, reported };
  const probed = await abandonGone(deliveryInput, listened.outcome);
  if (probed === "stop") {
    return { listenerOutcome: listened.outcome, reported };
  }

  // What Conductor says mid-pass is reported as it happens, not after the pass:
  // a Submission is something a person waits for.
  input.watcher.current = (moment) => reportMoment(deliveryInput, moment);
  let cursor = since;
  for (const delivery of listened.deliveries) {
    if (interruptFlag.interrupted) {
      break;
    }
    const handled = await handleFeatureDelivery(deliveryInput, delivery.payload);
    if (!handled.advance) {
      break;
    }
    cursor = delivery.cursor;
    await saveCursor(options.ledgerRoot, delivery.cursor);
  }

  // A Project with a Feature to open, make or fold moves on whether or not the
  // tracker mentioned it again: nothing else claims it, so a restart with only
  // waiting work would otherwise sit idle until a delivery that has no reason
  // to come.
  const projects = await projectsToSweep(ledger);
  if (projects.length > 0) {
    journal.append({ event: "sweep", projects });
  }
  for (const project of projects) {
    if (interruptFlag.interrupted) {
      break;
    }
    const run = await advanceProject(deliveryInput, project);
    if (run !== undefined) {
      lastRun = run;
    }
  }

  if (listened.deliveries.length === 0 && projects.length === 0) {
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

/** How long an idle loop goes without saying that it is still turning. */
export const HEARTBEAT_MS = 60_000;

export async function run(
  input: HostRunInput,
  now: () => number = Date.now,
): Promise<HostTickResult> {
  const { options, conductor, journal, trace } = input;
  const interruptFlag = options.interruptFlag ?? { interrupted: false };
  let last: HostTickResult = {
    listenerOutcome: "completed",
    reported: [],
  };
  let idlePasses = 0;
  let lastSaid = now();
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
    // Nothing printed for a minute looks the same as a hung process, so an idle
    // loop says once a minute that it is polling and found nothing to do.
    if (last.lastRun === undefined && last.reported.length === 0) {
      idlePasses += 1;
      if (now() - lastSaid >= HEARTBEAT_MS) {
        trace(
          `waiting    nothing to do: ${idlePasses} poll(s) in ${Math.round((now() - lastSaid) / 1000)}s`,
        );
        idlePasses = 0;
        lastSaid = now();
      }
    } else {
      idlePasses = 0;
      lastSaid = now();
    }
    await sleep(options.pollIntervalMs, interruptFlag);
  }
}

async function projectsToSweep(ledger: WorkLedger): Promise<string[]> {
  const features = await ledger.listFeatures();
  const projects = features
    .filter((summary) => SWEEP_STATES.has(summary.state))
    .map((summary) => summary.project);
  return [...new Set(projects)];
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
