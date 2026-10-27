import type { GateSpec } from "@bluewombat/implementer";
import type { ManagerModule } from "@bluewombat/manager-kit";

/**
 * What a Feature can say that makes Host leave a Gate out. Names are the ones a Gate's `skipWhen`
 * is written with, whatever the tracker calls the label behind them.
 */
export const SKIP_WHEN = ["skip-feature-test"] as const;
export type SkipWhen = (typeof SKIP_WHEN)[number];

/**
 * A Gate as the config writes it: Implementer's, and the condition under which Host does not run
 * it. A Gate that is not run is not a Gate that passed: Host says so in its journal and trace, and
 * the Gate itself knows nothing of it. Only a Feature's Gates take one.
 */
export type HostGateSpec = GateSpec & { skipWhen?: SkipWhen };

/**
 * A command with its own Gate sequence. Every role is gated independently —
 * no sharing, no dispatch choosing between two buckets (see DECISIONS.md).
 */
export type GatedPassSpec = PassSpec & { gates: HostGateSpec[] };

/**
 * A review: an agent and the Gates that follow it — or, with `agent: false`,
 * the Gates alone. Writing `agent: false` is how a Project turns the agent off
 * and keeps its checks; with no Gates either, the review is off altogether. A
 * review is always written, so that turning it off is a choice that shows.
 */
export type ReviewSpec = GatedPassSpec | { agent: false; gates: HostGateSpec[] };

/** Whether a review does anything: an agent to run, or Gates to ask. */
export function isOn(review: ReviewSpec | undefined): boolean {
  return review !== undefined && (hasAgent(review) || review.gates.length > 0);
}

/** Whether a review has an agent to run before its Gates. */
export function hasAgent(review: ReviewSpec): review is GatedPassSpec {
  return "cmd" in review;
}

/**
 * One tracker integration: the package that talks to it and the options that
 * package reads. Host never reads `options`.
 */
export type ManagerSpec<Package = string> = {
  /** Package name or path to a module that exports `createManager`. */
  package: Package;
  options: Record<string, unknown>;
};

/**
 * What `mason run` accepted. Nothing here names a tracker: whatever a
 * FeatureTracker or a TicketTracker needs travels in its `options`, which Host
 * does not read. The two may be the same package or two different ones.
 */
export type HostInvocation = {
  /** Where Features are written and signalled. */
  featureTracker: ManagerSpec;
  /** Where the Tickets of a Feature are written, and the Authority that holds the lines. */
  ticketTracker: ManagerSpec;
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
   * A second copy of the work line, kept on the branch a Feature is folded into.
   * It is what the target is merged from when a Feature is brought up to date.
   * Host keeps its own under `.mason/targetLine` when the reference allows;
   * required with an Authority otherwise.
   */
  workLineTargetStable?: string;
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
   * Prepare the workspace once it exists (install deps, …), before the Builder
   * runs in it. Absent: the Builder gets a cold tree.
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
  /** Making the unit of work, and judging what came out of it. */
  builder: StageSpec;
  /** Judging the assembled ticket, and fixing what a judgement refused. */
  ticket: TicketSpec;
  /**
   * Judging the whole Feature before its line is folded, and fixing what that
   * judgement refused. Required with an Authority, which is what folds a line;
   * without one nothing here is read.
   */
  feature?: FeatureSpec;
  /**
   * The outside judge, when the Project declares one. Absent or disabled: the
   * assembled ticket is folded into WorkLineStable and that fold is final.
   */
  authority?: AuthoritySpec;
  /**
   * What is filmed beyond the journal. Absent: the journal alone.
   */
  observability?: ObservabilitySpec;
  /** How long any one child outside a Task may run: manager, isolations. */
  timeoutMs: number;
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
 * like the Gates.
 */
export type AuthoritySpec = {
  enabled: boolean;
  publishArgv: string[];
  refreshArgv: string[];
  /**
   * Optional. Describes what is submitted, in the Project's own words:
   * spawned once per ticket in its workspace with `--id`, `--title`,
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
 * Making the unit of work: first pass, then repair when a Gate refused. The
 * config writes one `builder.gates` list; the loader puts it on both passes, so
 * a repair is judged by exactly what judged the producer (Implementer still takes
 * two sequences, one per command).
 */
export type StageSpec = {
  /** Produces from a specification. Judged by `builder.gates`. */
  producer: GatedPassSpec;
  /** Produces again, with the report of what refused the last pass. Judged by `builder.gates`. */
  repair: GatedPassSpec;
  /** Attempts one Task may start. Default 3. */
  maxAttempts?: number;
  /**
   * The Ticket that holds a Feature's feature tests (the tracker's feature-test label) is made by
   * this pass instead of the producer and the repair: its own command, its own Gates, nothing
   * borrowed from them. Declaring it declares the feature-test check: a Feature needs a feature-test Ticket or the
   * skip label, and a Feature Gate with `skipWhen: skip-feature-test` runs the suite.
   */
  featureTest?: GatedPassSpec;
};

/**
 * Judging the assembled ticket as a whole.
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
export type TicketSpec = {
  /**
   * How many Tickets of a Project may be worked on at once. Default 1: one
   * after the other. Above 1 needs `authority.enabled`.
   */
  maxParallel?: number;
  /** How many Attempts one fix may take. */
  maxAttempts?: number;
  /**
   * Times the work may be sent back before it escalates, by an Authority, by
   * `validate`, or by both — one shared budget. Default 3.
   */
  maxRefusals?: number;
  /** Fixes what a judgement of the whole refused. Needs `--report`. Judged by its own `gates`. */
  fix?: GatedPassSpec;
  /**
   * A local, read-only judge of the assembled ticket: whether it meets the
   * intention, before there is a Submission or a Gate sequence to answer that.
   * Optional. Runs after align, with or without an Authority. A refusal is
   * parked on the aggregate and repaired by `fix`, the same as an Authority's.
   * Judged by its own `gates`.
   */
  validate?: ReviewSpec;
  /** The judgement-only pass's own sequence — see above. */
  gates: HostGateSpec[];
};

/**
 * What happens to a Feature's line before it is folded: its own judgement, its
 * own fix and its own budget, apart from a Ticket's ticket.
 */
export type FeatureSpec = {
  /** Repairs the line when a judgement of it refused. Needs `--report`. Judged by its own `gates`. */
  fix: GatedPassSpec;
  /** How many Attempts one fix may take. */
  maxAttempts?: number;
  /**
   * Times the line may be sent back before the Feature escalates. One shared
   * budget, like a Ticket's. Default 3.
   */
  maxRefusals?: number;
  /**
   * A local, read-only review of the whole line against the Feature's request,
   * once the target has been merged into it, before the line is published. Its
   * `gates` are where the project's own checks on the whole line run (typecheck,
   * tests) beside the guards that it wrote nothing. Judged by its own gates, not
   * by `gates` below, which read the published branch.
   */
  validate: ReviewSpec;
  /** Judges the published line, with nothing produced (the CI). At least one. */
  gates: HostGateSpec[];
};

/**
 * An invocation still being assembled from the config file and the flags: a
 * side may have its package from one and an option from the other.
 */
export type HostDraft = Omit<Partial<HostInvocation>, "featureTracker" | "ticketTracker"> & {
  featureTracker?: Partial<ManagerSpec>;
  ticketTracker?: Partial<ManagerSpec>;
};

/** Import face: the invocation, plus the seams the CLI has no use for. */
export type HostOptions = Omit<
  HostInvocation,
  "featureTracker" | "ticketTracker" | "configDir" | "home" | "persist"
> & {
  /** A specifier to resolve, or an already-loaded module (tests, embedding). */
  featureTracker: ManagerSpec<string | ManagerModule>;
  ticketTracker: ManagerSpec<string | ManagerModule>;
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
