/** Domain types owned by FeatureBreakdown. Names match the Transformer perimeter only. */

export type RunOutcome =
  | "planned"
  | "refused"
  | "invalid-invocation"
  | "unavailable"
  | "interrupted";

export type StatusPhase =
  | "planning"
  | "planned"
  | "refused"
  | "unavailable"
  | "interrupted"
  | "invalid";

export type ClockName = "planner" | "gate";

export type RefusalCode =
  | "feature-too-large"
  | "feature-not-json"
  | "feature-not-object"
  | "bad-field-type"
  | "missing-key"
  | "missing-intention"
  | "not-specifiable"
  | "empty-plan"
  | "plan-too-large"
  | "bad-subtask-shape"
  | "missing-subtask-id"
  | "duplicate-id"
  | "missing-subtask-intention"
  | "missing-definition-of-done"
  | "bad-depends-on"
  | "unknown-dependency"
  | "cycle"
  | "no-root"
  /** A Gate refused `--workspace` after a Plan was otherwise accepted. */
  | "gate-refused";

export type GateVerdict = "pass" | "fail-retryable" | "fail-blocking";

export type GateSpec = {
  id: string;
  argv: string[];
  /** How long this Gate may take, at most. Required. */
  timeoutMs: number;
};

export type GateTraceEntry = {
  id: string;
  verdict: GateVerdict;
  report: string;
};

export type Status = {
  phase: StatusPhase;
  key?: string;
  label: string;
};

export type FeatureStandard = {
  key: string;
  intention: string;
  title?: string;
};

export type Subtask = {
  id: string;
  intention: string;
  definition_of_done: string;
  depends_on: string[];
};

export type Plan = {
  key: string;
  subtasks: Subtask[];
  fingerprint: string;
  planned_at: string;
};

/**
 * Somewhere a child's raw output is kept as it arrives.
 *
 * What the Planner says reaches this Transformer in full and leaves it as a
 * Plan or a refusal. A sink is whoever wants the stream behind that answer;
 * FeatureBreakdown neither opens files nor knows where it goes.
 */
export type ChildSink = {
  write(stream: "stdout" | "stderr", chunk: string): void;
  close(): void;
};

/** Which child is about to speak, for whoever decides whether to film it. */
export type ChildAbout = {
  /** The FeatureStandard being broken down. */
  key: string;
  kind: "planner" | "gate";
  /** Present when `kind` is `gate`. */
  gate_id?: string;
};

/** Answers a sink for one child, or nothing to leave it unfilmed. */
export type OpenChildSink = (about: ChildAbout) => ChildSink | undefined;

export type Invocation = {
  maxFeatureBytes: number;
  maxUnits: number;
  plannerArgv: string[];
  plannerDurationMs: number;
  /**
   * Where a Gate looks, once a Plan is otherwise accepted — not where the
   * Planner itself reads from (it takes that on its own argv, before `--`;
   * see SPECS.md §5a). Required: a Gate always has a `cwd`, even an empty list.
   */
  workspace: string;
  /** Judges the workspace after a Plan is otherwise accepted. May be empty. */
  gates: GateSpec[];
  /** Set when --feature was given. Absent: FeatureStandard comes from stdin. */
  featureJson?: string;
  onStatusArgv?: string[];
  /** Normalized ISO-8601 from --at. Absent: stamp the current time. */
  plannedAt?: string;
};

export type ParseFailure = {
  ok: false;
  reason: string;
};

export type ParseResult = { ok: true; invocation: Invocation } | ParseFailure;
