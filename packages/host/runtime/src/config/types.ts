import type { GateSpec as PlannerGateSpec } from "@bluewombat/feature-breakdown";
import type { GateSpec } from "@bluewombat/implementer";
import type { ManagerModule } from "@bluewombat/manager-kit";

/**
 * A command with its own Gate sequence. Every role is gated independently —
 * no sharing, no dispatch choosing between two buckets (see DECISIONS.md).
 */
export type GatedPassSpec<G = GateSpec> = PassSpec & { gates: G[] };

/**
 * What `mason run` accepted. Nothing here names a tracker: whatever a
 * FeatureManager needs travels in `managerOptions`, which Host does not read.
 */
export type HostInvocation = {
  /** Package name or path to a module that exports `createManager`. */
  manager: string;
  managerOptions: Record<string, unknown>;
  /** Where a relative manager option resolves — the config file's directory. */
  configDir: string;
  /**
   * Where Host keeps what is its own. `workspaceRoot`, `ledgerRoot` and the
   * copy of a reference work line live here unless each is placed elsewhere.
   */
  home: string;
  /**
   * The work line the operator maintains. Absent: the manager must name a
   * reference work line, and Host keeps its own copy under `.mason/work-line`.
   */
  workLineStable?: string;
  /**
   * The work line a fold lands on. Absent: what the manager's reference names,
   * or else whatever WorkLineStable has checked out, which is nobody's decision.
   */
  workLineBranch?: string;
  /**
   * Package name or path that exports an Isolation `strategy` (isolation + fold).
   * Host loads it the way it loads a manager. No aliases — not `"git"` / `"copy"`.
   */
  workLineIsolation: string;
  /**
   * What that strategy is told, unread by Host — like `managerOptions` for a
   * manager. Absent: the strategy's own defaults.
   */
  workLineIsolationOptions?: Record<string, unknown>;
  /**
   * Prepare a Feature workspace once it exists (install deps, …), before any
   * Subtask is isolated from it. Absent: Subtasks inherit a cold Feature.
   */
  workLineWarm?: PassSpec;
  workspaceRoot: string;
  ledgerRoot: string;
  /**
   * Package name or path exporting `openPersist`: how the ledger is stored
   * under `ledgerRoot`. Host loads it the way it loads a manager. Default
   * `@bluewombat/persist-fs`.
   */
  persist: string;
  /** FeatureStandard in, a Plan out. Gated: judges `workLineStable` once a Plan is accepted. */
  planner: GatedPassSpec<PlannerGateSpec>;
  /** Making a Subtask, and judging what came out of it. */
  builder: StageSpec;
  /** Judging the assembled feature, and fixing what a judgement refused. */
  assembly: AssemblySpec;
  /**
   * The outside judge, when the Project declares one. Absent or disabled: the
   * assembled feature is folded into WorkLineStable and that fold is final.
   */
  authority?: AuthoritySpec;
  /**
   * What is filmed beyond the journal. Absent: the journal alone, as before.
   */
  observability?: ObservabilitySpec;
  /** How long any one child outside a Task may run: Planner, manager, isolations. */
  timeoutMs: number;
  /**
   * Times the work may be sent back before it escalates, by an Authority, by
   * `assembly.validate`, or by both — one shared budget. Default 3.
   */
  maxRefusals?: number;
  pollIntervalMs?: number;
};

/**
 * What a run writes about itself, past the journal every run keeps.
 *
 * The journal films phases and verdicts and is always on. This is the level
 * under it: what a child actually said, as it said it. Large, bursty, and worth
 * nothing if keeping it can slow a run down — so it is written asynchronously,
 * may be lost, and is off unless the Project asks.
 */
export type ObservabilitySpec = {
  streams?: {
    enabled: boolean;
    /** Already resolved against the config directory. Default: `<home>/streams`. */
    dir?: string;
    /** Which of a child's two streams to keep. Default: both. */
    keep?: ("stdout" | "stderr")[];
  };
};

/**
 * The outside judge, and how the work is put in front of it.
 *
 * `enabled` is declared, never inferred: whether a Project offers its work to
 * somebody outside is a decision, not something to read off a directory. The
 * Publisher is the command that places the work where that judge looks, and the
 * Refresher the one that reads back what the judge accepted — two more slots,
 * like the Planner and the Gates.
 */
export type AuthoritySpec = {
  enabled: boolean;
  publishArgv: string[];
  refreshArgv: string[];
  /**
   * Optional. Describes what is submitted, in the Project's own words:
   * spawned once per feature in its workspace with `--id`, `--title`,
   * `--intention`, `--target`; answers `{ subject, body? }`. What the
   * Authority makes of it is the manager's (for GitHub: the fold's message
   * and the pull request's text). Absent: the title and the intention, as the
   * human wrote them.
   */
  describeArgv?: string[];
};

/**
 * One command, and the ceiling that bounds it.
 *
 * Both are named here and nowhere else. A pass that inherited its command from
 * a neighbour would run an agent nobody wrote down, which is the one thing a
 * config for autonomous work must never do.
 */
export type PassSpec = {
  cmd: string[];
  /** Required. Nothing else bounds a producer. */
  timeoutMs: number;
};

/**
 * Making a Subtask: first pass, then repair when a Gate refused, each judged
 * by its own Gate sequence — a repair Attempt with no gates of its own runs
 * ungated, even when the producer's list is not empty.
 */
export type StageSpec = {
  /** Produces from a specification. Judged by its own `gates`. */
  producer: GatedPassSpec;
  /** Produces again, with the report of what refused the last pass. Judged by its own `gates`. */
  repair: GatedPassSpec;
  /** Attempts one Task may start. Default 3. */
  maxAttempts?: number;
};

/**
 * Judging the assembled feature as a whole.
 *
 * The units are already validated. The Gates run either way. A command here is
 * not a second first-pass of the request: it is a surgical fix of what a
 * judgement refused. The work is sent back to `fix` by an Authority, by
 * `validate`, or by both — `doctor` checks that at least one refuser exists
 * before `fix` is declared, not `authority.enabled` alone.
 *
 * `fix` and `validate` each carry their own Gate sequence. `gates`, at this
 * level, is unrelated to either — it is the judgement-only pass with no
 * producer of its own (nothing new made, the existing assembled state
 * re-checked; e.g. `ci-green`), and was never shared with `fix` or `validate`.
 */
export type AssemblySpec = {
  /** Fixes what a judgement of the whole refused. Needs `--report`. Judged by its own `gates`. */
  fix?: GatedPassSpec;
  /**
   * A local, read-only judge of the assembled feature: whether it meets the
   * intention, before there is a Submission or a Gate sequence to answer that.
   * Optional. Runs after align, with or without an Authority. A refusal is
   * parked on the aggregate and repaired by `fix`, the same as an Authority's.
   * Judged by its own `gates`.
   */
  validate?: GatedPassSpec;
  maxAttempts?: number;
  /** The judgement-only pass's own sequence — see above. */
  gates: GateSpec[];
};

/** Import face: the invocation, plus the seams the CLI has no use for. */
export type HostOptions = Omit<
  HostInvocation,
  "manager" | "managerOptions" | "configDir" | "home" | "persist"
> & {
  /** A specifier to resolve, or an already-loaded module (tests, embedding). */
  manager: string | ManagerModule;
  managerOptions?: Record<string, unknown>;
  configDir?: string;
  /** Defaults to `@bluewombat/persist-fs`. */
  persist?: string;
  /** Defaults to `.mason` under `configDir`. */
  home?: string;
  interruptFlag?: { interrupted: boolean };
  /** Read for a secret a manager names. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Where the run says what it is doing. Defaults to stdout. */
  write?: (text: string) => void;
};
