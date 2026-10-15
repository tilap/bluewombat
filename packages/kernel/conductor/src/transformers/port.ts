export type IsolateInput = {
  id: string;
  parent: string;
  child: string;
  durationMs: number;
  /**
   * The larger piece of work this isolation serves.
   *
   * The id names the space, and a reader parsing the Ticket back out of it is
   * guessing at a format nobody promised. Said here, it is a fact.
   */
  context?: string;
};

export type IsolateOutcome = "isolated" | "failed" | "invalid-invocation" | "interrupted";

export type ImplementTrace = {
  ended: string;
  /**
   * What the Attempt ended on, in the words of whatever refused it.
   *
   * `ended` says an Attempt failed; this says why. Whoever drives the next one
   * has to hand that to the producer, and cannot invent it — a refusal with no
   * reason sends the next Attempt back blind.
   */
  report?: string;
  /**
   * Which check produced `report`, when one did.
   *
   * A report reaching a producer unattributed is told as "something refused
   * this". Naming it costs nothing here and is the difference between the
   * producer knowing what looked at its work and guessing.
   */
  refusedBy?: string;
};

export type ImplementInput = {
  id: string;
  intention: string;
  workspace: string;
  /** What a pass before this one left unresolved. Read by the producer. */
  report?: string;
  /** What produced `report`, when it has a name. */
  reportFrom?: string;
  /**
   * The larger piece of work this Task serves.
   *
   * The Task's own id names the unit; this names what the unit is part of.
   * Passed down untouched, for whoever keeps a record of a pass and has to file
   * it where a person will look for it.
   */
  context?: string;
  /**
   * What is being judged: the unit of work, or the work once assembled.
   *
   * They are not the same situation, and a check written for one can be wrong
   * for the other — "nothing changed" means nothing was done in a unit, and is
   * the correct outcome for an assembly that needed nothing.
   */
  stage?: "unit" | "assembly";
  /**
   * Whether this Task may produce, or only be judged.
   *
   * A stage made only of already-validated work has nothing to make. Asking a
   * producer to run there is how a correct result gets rewritten so that a check
   * expecting a change is satisfied. Default: it may.
   */
  produce?: boolean;
  /**
   * The read-only judge of an assembled ticket, distinct from both halves
   * `produce` already names.
   *
   * `produce: false` is the Gate sequence: it reads what was published.
   * `produce: true` is `assembly.fix`: it writes. `validate: true` is neither —
   * it reads the diff against the intention and answers directly, before there
   * is anything for a Gate to read or a Submission to hold its verdict. Absent:
   * `stage` and `produce` decide alone.
   */
  validate?: boolean;
};

export type ImplementResult = {
  outcome: "validated" | "escalated" | "interrupted" | "invalid-invocation";
  traces: ImplementTrace[];
};

export type IntegrateInput = {
  id: string;
  parent: string;
  child: string;
  durationMs: number;
  /** The larger piece of work this fold serves. Same reason as `IsolateInput`. */
  context?: string;
  /** What the folded work is, for whoever reads the history it leaves. */
  subject?: string;
  /** What the fold itself is, when it has to leave a merge of its own. */
  mergeSubject?: string;
};

export type IntegrateOutcome =
  | "integrated"
  | "conflict"
  | "failed"
  | "invalid-invocation"
  | "interrupted";

export type TransformerPort = {
  isolate(input: IsolateInput): Promise<{ outcome: IsolateOutcome }>;
  implement(input: ImplementInput): Promise<ImplementResult>;
  integrate(input: IntegrateInput): Promise<{ outcome: IntegrateOutcome }>;
};

/**
 * The outside judge of a Submission.
 *
 * Conductor knows nothing of what an Authority is made of: whoever wires it
 * decides. With no Authority, an assembled ticket is folded into the work line
 * directly, which is what happened before any of this existed.
 */
export type SubmitInput = {
  key: string;
  project: string;
  /** Where the work now stands, in whatever terms the Authority reads. */
  ref: string;
  /** The work line it is offered to. */
  target: string;
  /** The Ticket's workspace, where the whole change is: absolute. */
  workspace: string;
  title?: string;
  intention?: string;
  /**
   * A name the work already has at the Authority: a Feature's line. Absent, the
   * work is published under the name the isolation strategy gives `ref`.
   */
  branch?: string;
};

export type SubmitResult =
  | { outcome: "submitted"; reference: string }
  | { outcome: "refused"; reason: string }
  | { outcome: "unavailable" };

export type AuthorityFoldResult =
  /** `reference`: the work line's own name for the fold — a commit, a revision. Opaque. */
  | { outcome: "folded"; reference?: string }
  | { outcome: "conflict"; reason: string }
  | { outcome: "unavailable" };

/**
 * The outside authority, as two actions and nothing else.
 *
 * It does not answer whether the work is good: that is a judgement, and a
 * judgement is a Gate. An Authority publishes and it folds.
 */
export type AuthorityPort = {
  submit(input: SubmitInput): Promise<SubmitResult>;
  fold(input: { reference: string }): Promise<AuthorityFoldResult>;
};
