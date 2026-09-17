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
  }
  return run;
}
