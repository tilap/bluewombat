/** Domain types owned by Isolator. Names match the Transformer perimeter only. */

export type IsolationOutcome = "invalid-invocation" | "isolated" | "failed" | "interrupted";

export type StatusPhase = "isolating" | "isolated" | "failed" | "interrupted" | "invalid";

export type ClockName = "isolation";

export type Status = {
  phase: StatusPhase;
  id?: string;
  label: string;
};

export type Invocation = {
  id: string;
  parent: string;
  child: string;
  durationMs: number;
  onStatusArgv?: string[];
};

export type ParseFailure = {
  ok: false;
  reason: string;
  id?: string;
  onStatusArgv?: string[];
};

export type ParseResult = { ok: true; invocation: Invocation; strategy: string } | ParseFailure;
