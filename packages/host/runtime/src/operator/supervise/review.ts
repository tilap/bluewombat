import { lastJson } from "./decision.js";

export type Verdict =
  | { ok: true; approve: true; checked: string[]; deferred: string[] }
  | { ok: true; approve: false; reasons: string[]; points: number[] }
  | { ok: false; reason: string };

/**
 * The guard's answer. An approval has to show what was checked, and has nothing
 * left unverified: a guard that says yes without evidence has said nothing.
 * A proposal is not written yet: what can only be checked once it is stays with the
 * fixer and the guard of the diff (`deferred`) and does not stop it.
 */
export function parseVerdict(output: string, options: { proposal?: boolean } = {}): Verdict {
  const value = lastJson(output);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "no JSON object in the guard's answer" };
  }
  const o = value as Record<string, unknown>;
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
  const checked = strings(o.checked);
  const unverified = strings(o.unverified);
  const raw = (Array.isArray(o.findings) ? o.findings : []).map(
    (item) => (item ?? {}) as Record<string, unknown>,
  );
  const points = raw.flatMap((f) => (typeof f.point === "number" ? [f.point] : []));
  const findings = raw.map((f) => {
    return `point ${String(f.point ?? "?")}: ${String(f.problem ?? "")} (${String(f.evidence ?? "no evidence")}) — required: ${String(f.required ?? "")}`;
  });
  if (o.verdict === "reject") {
    return {
      ok: true,
      approve: false,
      reasons: findings.length > 0 ? findings : ["rejected without a finding"],
      points,
    };
  }
  if (o.verdict !== "approve") {
    return { ok: false, reason: 'verdict must be "approve" or "reject"' };
  }
  if (checked.length === 0) {
    return { ok: false, reason: "an approval must list what was checked" };
  }
  if (findings.length > 0 || (unverified.length > 0 && options.proposal !== true)) {
    return {
      ok: true,
      approve: false,
      reasons: [...findings, ...unverified.map((u) => `unverified: ${u}`)],
      points,
    };
  }
  return {
    ok: true,
    approve: true,
    checked,
    deferred: options.proposal === true ? unverified : [],
  };
}
