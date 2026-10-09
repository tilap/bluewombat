export type GateVerdictJson = {
  verdict: "pass" | "fail-retryable" | "fail-blocking";
  report: string;
};

function firstJsonObject(text: string): unknown | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }
  // Prefer the last non-empty line (children may log before the JSON object).
  const lines = trimmed.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const candidate = lines.length > 0 ? lines[lines.length - 1] : trimmed;
  if (candidate === undefined) {
    return null;
  }
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return null;
    }
  }
}

export function parseGateVerdictJson(stdout: string): GateVerdictJson | null {
  const value = firstJsonObject(stdout);
  if (value === null || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const verdict = record.verdict;
  if (verdict !== "pass" && verdict !== "fail-retryable" && verdict !== "fail-blocking") {
    return null;
  }
  return { verdict, report: typeof record.report === "string" ? record.report : "" };
}
