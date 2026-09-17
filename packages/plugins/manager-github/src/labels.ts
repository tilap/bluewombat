/** Whether a GitHub-shaped payload carries this label, ignoring case. */
export function payloadHasLabel(payload: Record<string, unknown>, label: string): boolean {
  const labels = payload.labels;
  if (!Array.isArray(labels)) {
    return false;
  }
  const wanted = label.toLowerCase();
  for (const entry of labels) {
    if (typeof entry === "string") {
      if (entry.trim().toLowerCase() === wanted) {
        return true;
      }
      continue;
    }
    if (entry !== null && typeof entry === "object" && "name" in entry) {
      const name = (entry as { name?: unknown }).name;
      if (typeof name === "string" && name.trim().toLowerCase() === wanted) {
        return true;
      }
    }
  }
  return false;
}
