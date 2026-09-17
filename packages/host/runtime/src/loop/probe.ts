import type { FeatureState } from "@bluewombat/work-ledger";
import type { HostDeliveryInput } from "./context.js";
import { handleCancel } from "./deliveries.js";

/**
 * States abandon is still legal for. `merging` is the point of no return;
 * terminal and `invalid` are not holding a Project.
 */
const ABANDONABLE: ReadonlySet<FeatureState> = new Set([
  "received",
  "planning",
  "running",
  "escalated",
  "integrating",
  "submitted",
]);

/**
 * Listen outcomes that never reached the tracker. Probing after one of these
 * would read a dead token as every Feature disappearing.
 */
const LISTEN_MISSED_SOURCE: ReadonlySet<string> = new Set([
  "source-lost",
  "interrupted",
  "invalid-invocation",
]);

/**
 * Ask the manager whether Features Host already holds are still on the tracker.
 *
 * A poll cannot see an absence: a deleted item never appears again. `gone` is
 * the same abandon as a `cancel` delivery. `unavailable` is not.
 */
export async function abandonGone(
  input: HostDeliveryInput,
  listenOutcome: string,
): Promise<"ok" | "stop"> {
  if (input.manager.probe === undefined || LISTEN_MISSED_SOURCE.has(listenOutcome)) {
    return "ok";
  }
  const summaries = await input.ledger.list();
  for (const summary of summaries) {
    if (input.options.interruptFlag?.interrupted === true) {
      return "stop";
    }
    if (!ABANDONABLE.has(summary.state)) {
      continue;
    }
    const outcome = await input.manager.probe(summary.key);
    if (outcome === "interrupted") {
      return "stop";
    }
    if (outcome !== "gone") {
      if (outcome === "unavailable") {
        input.journal.append({ event: "probed", key: summary.key, outcome });
      }
      continue;
    }
    input.journal.append({ event: "probed", key: summary.key, outcome: "gone" });
    input.trace(`gone       ${summary.key}`);
    await handleCancel({ key: summary.key, project: summary.project }, input);
  }
  return "ok";
}
