/** Domain types owned by Integrator. Names match the Transformer perimeter only. */

export type IntegrationOutcome =
  | "invalid-invocation"
  | "integrated"
  | "conflict"
  | "failed"
  | "interrupted";

export type StatusPhase =
  | "integrating"
  | "integrated"
  | "conflict"
  | "failed"
  | "interrupted"
  | "invalid";

export type ClockName = "integration";

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
  /** What the folded work is, for whoever reads the history it leaves. */
  subject?: string;
  /** What the fold itself is, when it has to leave a merge of its own. */
  mergeSubject?: string;
  onStatusArgv?: string[];
};

export type ParseFailure = {
  ok: false;
  reason: string;
  id?: string;
  onStatusArgv?: string[];
};

export type ParseResult = { ok: true; invocation: Invocation; strategy: string } | ParseFailure;
