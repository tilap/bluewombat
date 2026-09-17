import type { ManagerPort } from "./port.js";

/**
 * What Host hands a manager package at boot. `options` is the config file's
 * `managerOptions` object, unread: Host never validates a tracker's fields.
 */
export type ManagerContext = {
  options: Record<string, unknown>;
  /** Wall clock every call of this manager must stay inside. */
  durationMs: number;
  /** Flips on SIGINT / SIGTERM. Long calls must stop when it is true. */
  interruptFlag: { interrupted: boolean };
  /** Directory a relative option path resolves against (the config file's). */
  configDir: string;
  /** Where a secret named by an option is read from. Never logged by Host. */
  env: Record<string, string | undefined>;
};

export type CreateManagerResult =
  | { ok: true; manager: ManagerPort }
  | { ok: false; reason: string };

export type FindingLevel = "ok" | "warn" | "fail";

/** One line of `mason doctor`. `fail` is what makes the command exit non-zero. */
export type Finding = {
  level: FindingLevel;
  label: string;
  detail?: string;
};

/**
 * What `mason init` asks a manager for. Host writes the config and the slot
 * stubs; the manager fills `managerOptions` and any directories it needs.
 * Nothing here is tracker-shaped: a GitHub repo or a Linear team lives in
 * `options`, in words the manager chose.
 */
export type ManagerScaffold = {
  options: Record<string, unknown>;
  nextSteps: string[];
  prepare?(cwd: string): void;
};

/**
 * One thing `mason init` asks a human, to fill one `managerOptions` key.
 *
 * The manager owns the wording and the validation — "owner/name" is GitHub's
 * vocabulary, not Host's. Host owns the terminal: it reads the line, and hands
 * it back here to be turned into a value.
 */
export type ManagerQuestion = {
  /** The `managerOptions` key the answer fills. */
  key: string;
  /** One line, no trailing colon: `GitHub repository (owner/name)`. */
  prompt: string;
  /** Offered on the line, and used when the answer is empty. */
  fallback?: string;
  /** An empty answer with no fallback is refused, and the question repeats. */
  required?: boolean;
  /** Turns the typed line into the option value, or says what is wrong with it. */
  parse?(answer: string): { ok: true; value: unknown } | { ok: false; reason: string };
};

/**
 * One thing the tracker needs before a run — a label that must exist, a
 * permission the token must hold.
 *
 * `satisfied` it already was; `missing` it is not there yet and `apply` was
 * false; `applied` this call created it; `blocked` nothing here can fix it.
 */
export type SetupStep = {
  /** Stable across runs, so two reports can be compared: `label:mason`. */
  id: string;
  summary: string;
  state: "satisfied" | "missing" | "applied" | "blocked";
  detail?: string;
};

export type SetupResult = {
  /** False when a step is `blocked`. A `missing` step in a plan is not a failure. */
  ok: boolean;
  steps: SetupStep[];
};

/**
 * The module shape `manager` in the config resolves to. A package that exports
 * `createManager` is a manager; nothing else is required of it.
 */
export type ManagerModule = {
  createManager(context: ManagerContext): CreateManagerResult | Promise<CreateManagerResult>;
  /** Optional. What `mason doctor` reports for this manager. Must not use the network. */
  checkManager?(context: ManagerContext): Finding[] | Promise<Finding[]>;
  /** Optional. What `mason init` writes into `managerOptions`. */
  scaffoldManager?(context: ManagerContext): ManagerScaffold | Promise<ManagerScaffold>;
  /**
   * Optional. What `mason init` asks when it runs interactively, in order.
   * Declaring the questions rather than asking them keeps every read of the
   * terminal in Host, and every word about the tracker here.
   */
  questionsManager?(context: ManagerContext): ManagerQuestion[] | Promise<ManagerQuestion[]>;
  /**
   * Optional. What `mason setup` does. The only hook allowed to reach the
   * tracker over the network and to write to it.
   *
   * With `apply` false it reports a plan and changes nothing — that is the
   * default, because creating labels on somebody's repository is not a side
   * effect to have by accident. It must be idempotent: a second call with
   * `apply` true reports every step `satisfied` and writes nothing.
   */
  setupManager?(
    context: ManagerContext,
    input: { apply: boolean },
  ): SetupResult | Promise<SetupResult>;
  /**
   * Optional. Where the Authority keeps the reference work line.
   *
   * Opaque here, like `options`: the words are the Isolation strategy's, and
   * Host copies them through unread. Declaring it lets Host keep its own copy
   * of the work line under the ledger's roof instead of asking the operator to
   * maintain one. A manager with no Authority has no reference to name.
   */
  referenceManager?(context: ManagerContext): Record<string, unknown> | undefined;
};
