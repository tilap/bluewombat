import type { ProjectRunResult } from "@bluewombat/conductor";
import type { HostDeliveryInput } from "./context.js";
import { journalTicket, reportAfterRun } from "./report.js";
import { describeTicket } from "./trace.js";

/**
 * Drive one Project and report on the Ticket that actually ran.
 *
 * A delivery names a key; `runProject` drives whoever is active on that
 * Project. Attributing the outcome to the delivered key closed the wrong
 * issue, or posted an escalation on one that had only been admitted.
 *
 * A Project with an `escalated` Ticket is not driven: the caller checks first.
 */
export async function driveProject(
  input: HostDeliveryInput,
  project: string,
  fallbackKey: string,
): Promise<ProjectRunResult> {
  await input.conductor.reconcile(project);
  const run = await input.conductor.runProject(project);
  // idle / refused name no Ticket; the delivered key is the only one we have.
  const key = "key" in run && run.key !== undefined ? run.key : fallbackKey;
  const got = await input.ledger.get(key);
  if (got.ok) {
    const line = describeTicket(got.aggregate);
    // A held Ticket is swept every poll; repeating the same line on stdout
    // looks like the loop is stuck printing, not waiting.
    const traced = `trace:${key}:${line}`;
    if (input.said === undefined || !input.said.has(traced)) {
      if (input.said !== undefined) {
        for (const entry of [...input.said]) {
          if (entry.startsWith(`trace:${key}:`)) {
            input.said.delete(entry);
          }
        }
        input.said.add(traced);
      }
      input.trace(line);
    }
    journalTicket(input.journal, run.outcome, got.aggregate, input.said);
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
 * Drive, then keep driving while a refusal is waiting for repair.
 *
 * Conductor returns `paused` after `recordRefusal` or `recordParkedRefusal`
 * (state `integrating` with a report held, either on the Submission or parked
 * on the aggregate) so the tracker hears "repair is on its way" before the
 * next pass. Waiting a poll interval for that next pass is empty time: the
 * work is local. Re-drive in the same Host tick until that case is gone — a
 * new `submitted`, an escalation, or any non-`paused` outcome (e.g.
 * align-conflict).
 *
 * Do not continue from `submitted`: judging the Authority waits on the outside
 * and must leave room for listen / probe between ticks.
 */
export async function driveUntilBlocked(
  input: HostDeliveryInput,
  project: string,
  fallbackKey: string,
): Promise<ProjectRunResult> {
  let last = await driveProject(input, project, fallbackKey);
  const interruptFlag = input.options.interruptFlag ?? { interrupted: false };
  while (!interruptFlag.interrupted && last.outcome === "paused") {
    const key = "key" in last && last.key !== undefined ? last.key : fallbackKey;
    const got = await input.ledger.get(key);
    if (
      !got.ok ||
      got.aggregate.state !== "integrating" ||
      (got.aggregate.submission?.last_report === undefined &&
        got.aggregate.parked_refusal === undefined)
    ) {
      break;
    }
    last = await driveProject(input, project, key);
  }
  return last;
}
