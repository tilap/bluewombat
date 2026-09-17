/** The issue number encoded in `owner/name#42`. */
export function issueNumberFromExternalId(externalId: string): number | undefined {
  const hash = externalId.lastIndexOf("#");
  if (hash < 0) {
    return undefined;
  }
  return parsePositiveInt(externalId.slice(hash + 1));
}

/** The issue number a listing or webhook payload carries. */
export function issueNumberFromPayload(payload: Record<string, unknown>): number | undefined {
  const nested = payload.issue;
  if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
    const inner = issueNumberFromPayload(nested as Record<string, unknown>);
    if (inner !== undefined) {
      return inner;
    }
  }
  return parsePositiveInt(payload.number);
}

function parsePositiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (parsed > 0) {
      return parsed;
    }
  }
  return undefined;
}
