import { fingerprintOf } from "./adapter/normalize/fingerprint.js";
import { isStateLabel, type StateLabels } from "./state-labels.js";

/**
 * What a human wrote on the issue: title, body, state, and the labels that are
 * not this manager's own. A comment or a state label moves `updated_at`, and
 * neither is a change to the intention.
 */
export function writtenFingerprint(
  payload: Record<string, unknown>,
  stateLabels: StateLabels | undefined,
): string {
  const labels = labelNames(payload)
    .filter((name) => stateLabels === undefined || !isStateLabel(stateLabels, name))
    .sort();
  return fingerprintOf({
    title: payload.title,
    body: payload.body,
    state: payload.state,
    labels,
  });
}

function labelNames(payload: Record<string, unknown>): string[] {
  const labels = payload.labels;
  if (!Array.isArray(labels)) {
    return [];
  }
  const names: string[] = [];
  for (const entry of labels) {
    if (typeof entry === "string") {
      names.push(entry);
    } else if (entry !== null && typeof entry === "object" && "name" in entry) {
      const name = (entry as { name?: unknown }).name;
      if (typeof name === "string") {
        names.push(name);
      }
    }
  }
  return names;
}
