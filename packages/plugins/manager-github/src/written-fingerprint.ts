import { fingerprintOf } from "./adapter/normalize/fingerprint.js";

/**
 * What a human wrote on the issue: title, body, state, and the labels that are
 * not this manager's own. A comment or a state label moves `updated_at`, and
 * neither is a change to the intention.
 */
export function writtenFingerprint(
  payload: Record<string, unknown>,
  stateLabelPrefix: string | undefined,
): string {
  const labels = labelNames(payload)
    .filter(
      (name) =>
        stateLabelPrefix === undefined ||
        !name.toLowerCase().startsWith(stateLabelPrefix.toLowerCase()),
    )
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
