import type { ProjectRunResult } from "@bluewombat/conductor";
import type { HostDeliveryInput } from "./context.js";
import { journalFeature, pushReport, reportAfterRun } from "./report.js";
import { describeFeature } from "./trace.js";

/**
 * Drive one Project and report on the Feature that actually ran.
 *
 * A delivery names a key; `runProject` drives whoever is active on that
 * Project. Attributing the outcome to the delivered key closed the wrong
 * issue, or posted an escalation on one that had only been admitted.
 *
 * An `escalated` Feature is frozen until a human answers: driving it only
 * repeats the verdict. The delivered key is journaled as queued, and a
 * `progress` Event says so once on the tracker.
 */
export async function driveProject(
  input: HostDeliveryInput,
  project: string,
  fallbackKey: string,
): Promise<ProjectRunResult | undefined> {
  const held = await input.ledger.activeOn(project);
  if (held?.state === "escalated") {
    input.journal.append({ event: "queued", key: fallbackKey, behind: held.key });
    input.trace(`queued     ${fallbackKey} behind ${held.key} (escalated)`);
    await pushReport(input, {
      event: "progress",
      key: fallbackKey,
      project,
      eventId: `${fallbackKey}:queued:${held.key}`,
      fields: {
        summary: `Queued behind ${held.key}, which is escalated.`,
      },
    });
    return undefined;
  }
  await input.conductor.reconcile(project);
  const run = await input.conductor.runProject(project);
  // idle / refused name no Feature; the delivered key is the only one we have.
  const key = "key" in run && run.key !== undefined ? run.key : fallbackKey;
  const got = await input.ledger.get(key);
  if (got.ok) {
    input.trace(describeFeature(got.aggregate));
    journalFeature(input.journal, run.outcome, got.aggregate, input.said);
    await reportAfterRun(input, run, got.aggregate);
    // The work landed, or it was abandoned: nobody is going to read what the
    // agents said on the way. An escalation keeps everything — that is the one
    // outcome where a person has to go and look. What each file held was
    // already said in the film, so the shape of the run survives the bytes.
    if (got.aggregate.state === "done" || got.aggregate.state === "cancelled") {
      input.streams?.discard(key);
    }
  }
  return run;
}

/**
 * Drive, then keep driving while a Submission refusal is waiting for repair.
 *
 * Conductor returns `paused` after `recordRefusal` (state `integrating` with
 * `last_report`) so the tracker hears "repair is on its way" before the next
 * pass. Waiting a poll interval for that next pass is empty time: the work is
 * local. Re-drive in the same Host tick until that case is gone — a new
 * `submitted`, an escalation, or any non-`paused` outcome (e.g. align-conflict).
 *
 * Do not continue from `submitted`: judging the Authority waits on the outside
 * and must leave room for listen / probe between ticks.
 */
export async function driveUntilBlocked(
  input: HostDeliveryInput,
  project: string,
  fallbackKey: string,
): Promise<ProjectRunResult | undefined> {
  let last = await driveProject(input, project, fallbackKey);
  if (last === undefined) {
    return undefined;
  }
  const interruptFlag = input.options.interruptFlag ?? { interrupted: false };
  while (!interruptFlag.interrupted && last.outcome === "paused") {
    const key = "key" in last && last.key !== undefined ? last.key : fallbackKey;
    const got = await input.ledger.get(key);
    if (
      !got.ok ||
      got.aggregate.state !== "integrating" ||
      got.aggregate.submission?.last_report === undefined
    ) {
      break;
    }
    const next = await driveProject(input, project, key);
    if (next === undefined) {
      break;
    }
    last = next;
  }
  return last;
}
