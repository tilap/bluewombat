import type { FeatureState, TicketState } from "@bluewombat/work-ledger";
import type { HostDeliveryInput } from "./context.js";
import { handleCancel } from "./deliveries.js";
import { cancelFeatureFlow } from "./features.js";

/**
 * States abandon is still legal for. `merging` is the point of no return;
 * terminal ones are not holding a Project.
 */
const ABANDONABLE_TICKET: ReadonlySet<TicketState> = new Set([
  "received",
  "running",
  "escalated",
  "integrating",
  "submitted",
]);

const ABANDONABLE_FEATURE: ReadonlySet<FeatureState> = new Set([
  "waiting",
  "open",
  "submitted",
  "escalated",
]);

/**
 * Listen outcomes that never reached the tracker. Probing after one of these
 * would read a dead token as everything disappearing.
 */
const LISTEN_MISSED_SOURCE: ReadonlySet<string> = new Set([
  "source-lost",
  "interrupted",
  "invalid-invocation",
]);

/**
 * Ask the trackers whether what Host already holds is still there.
 *
 * A poll cannot see an absence: a deleted item never appears again. `gone` is
 * the same abandon as a `cancel` delivery. `unavailable` is not.
 */
export async function abandonGone(
  input: HostDeliveryInput,
  listenOutcome: string,
): Promise<"ok" | "stop"> {
  if (LISTEN_MISSED_SOURCE.has(listenOutcome)) {
    return "ok";
  }
  const interrupted = (): boolean => input.options.interruptFlag?.interrupted === true;

  if (input.features.probe !== undefined) {
    for (const summary of await input.ledger.listFeatures()) {
      if (interrupted()) {
        return "stop";
      }
      if (!ABANDONABLE_FEATURE.has(summary.state)) {
        continue;
      }
      const outcome = await input.features.probe(summary.key);
      if (outcome === "interrupted") {
        return "stop";
      }
      if (outcome === "unavailable") {
        input.journal.append({ event: "probed", key: summary.key, outcome });
      }
      if (outcome === "gone") {
        input.journal.append({ event: "probed", key: summary.key, outcome: "gone" });
        input.trace(`gone       ${summary.key}`);
        await cancelFeatureFlow(input, summary.key);
      }
    }
  }

  if (input.tickets.probe !== undefined) {
    for (const summary of await input.ledger.list()) {
      if (interrupted()) {
        return "stop";
      }
      if (!ABANDONABLE_TICKET.has(summary.state)) {
        continue;
      }
      const outcome = await input.tickets.probe(summary.key);
      if (outcome === "interrupted") {
        return "stop";
      }
      if (outcome === "unavailable") {
        input.journal.append({ event: "probed", key: summary.key, outcome });
      }
      if (outcome === "gone") {
        input.journal.append({ event: "probed", key: summary.key, outcome: "gone" });
        input.trace(`gone       ${summary.key}`);
        await handleCancel({ key: summary.key, project: summary.project }, input);
      }
    }
  }
  return "ok";
}
