/** Domain types owned by Implementer. Names match the Transformer perimeter only. */

export type RunOutcome = "invalid-invocation" | "validated" | "escalated" | "interrupted";

export type AttemptEnded = "validated" | "fail-retryable" | "fail-blocking" | "interrupted";

export type GateVerdict = "pass" | "fail-retryable" | "fail-blocking";

export type BuilderResultKind =
  | "completed"
  | "failed"
  | "timed_out"
  | "interrupted"
  | "refused"
  /** There was no producer to run: the Attempt is its Gate sequence alone. */
  | "skipped";

export type StatusPhase =
  | "building"
  | "gating"
  | "validated"
  | "escalated"
  | "interrupted"
  | "invalid";

export type Status = {
  phase: StatusPhase;
  attempt?: number;
  max_attempts?: number;
  gate_id?: string;
  label: string;
};

export type BuilderInput = {
  intention: string;
  definition_of_done: string;
  report?: string;
};

export type BuilderResult = {
  kind: BuilderResultKind;
  /** fail-retryable or fail-blocking when kind is failed / refused / timed_out */
  outcome?: "fail-retryable" | "fail-blocking";
  detail?: string;
};

export type GateTraceEntry = {
  id: string;
  verdict: GateVerdict;
  report: string;
};

export type Trace = {
  task_id: string;
  attempt: number;
  builder: {
    input: BuilderInput;
    result: BuilderResult;
  };
  gates: GateTraceEntry[];
  ended: AttemptEnded;
};

export type GateSpec = {
  id: string;
  argv: string[];
  /**
   * How long this Gate may take, at most. Required.
   *
   * Every child of an Attempt carries its own ceiling, and none is ever derived
   * from what another child left behind. A Gate that waits on something outside
   * — a check, a person — is then the only one paying for that wait.
   */
  timeoutMs: number;
};

export type Invocation = {
  id: string;
  intention: string;
  definitionOfDone: string;
  workspace: string;
  /**
   * The producer. Absent: an Attempt is its Gate sequence alone.
   *
   * Some Tasks only need judging — a stage whose work is already done, or one
   * whose answer comes from outside. Making one produce so that it can be
   * judged is how a correct result gets rewritten for no reason.
   */
  builderArgv?: string[];
  /**
   * The producer for a pass that has something to resolve, instead of `builderArgv`.
   *
   * Making from a specification and repairing what a check refused are not the
   * same job, and they are not always best done by the same agent or the same
   * prompt. Absent: `builderArgv` does both.
   *
   * Chosen on the presence of a report, not on the Attempt number: a Task run
   * again because something outside judged its result carries one from its very
   * first Attempt.
   */
  repairArgv?: string[];
  gates: GateSpec[];
  /**
   * What a pass before this invocation left unresolved.
   *
   * Attempt 1 usually has nothing to say to the Builder. When the Task is run
   * again because something outside judged the last result, that judgement is
   * the report, and the Builder reads it exactly as it reads a Gate's.
   */
  report?: string;
  /** Which Gate produced `report`, when a Gate did. */
  reportFrom?: string;
  /**
   * One piece of work, or the whole that pieces assemble into.
   *
   * A check written for one can be wrong for the other, so each is told which
   * it is looking at rather than left to guess. Absent: a piece of work.
   */
  stage?: "unit" | "assembly";
  /**
   * What this Task belongs to, passed to the producer and used for nothing else.
   *
   * A Task's own id says which unit of work it is, not which larger piece of
   * work that unit serves. A producer keeping a record of its turn needs the
   * second to file it somewhere a person can find it again.
   */
  context?: string;
  maxAttempts: number;
  /** How long the producer may run, at most. Required: nothing else bounds it. */
  builderTimeoutMs: number;
  /** The same, for `repairArgv`. Absent: `builderTimeoutMs`. */
  repairTimeoutMs?: number;
  onStatusArgv?: string[];
};

export type ParseResult = { ok: true; invocation: Invocation } | { ok: false; reason: string };
