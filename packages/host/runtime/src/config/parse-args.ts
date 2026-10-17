import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { GateSpec } from "@bluewombat/implementer";
import { DEFAULT_PERSIST, ISOLATION_GIT } from "./defaults.js";
import { findConfig } from "./find-config.js";
import { homeOf, inHome } from "./home.js";
import { loadConfig } from "./load-config.js";
import {
  type GatedPassSpec,
  type HostDraft,
  type HostInvocation,
  hasAgent,
  type PassSpec,
  type ReviewSpec,
  type TicketSpec,
} from "./types.js";

const HOST_FLAGS = new Set([
  "--config",
  "--feature-tracker",
  "--feature-tracker-option",
  "--ticket-tracker",
  "--ticket-tracker-option",
  "--home",
  "--work-line-stable",
  "--work-line-branch",
  "--work-line-isolation",
  "--workspace-root",
  "--ledger",
  "--persist",
  "--streams-dir",
  "--timeout-ms",
  "--poll-interval-ms",
  "--builder",
  "--builder-timeout-ms",
  "--builder-max-attempts",
  "--builder-repair",
  "--builder-repair-timeout-ms",
  "--builder-gate",
  "--builder-gate-timeout-ms",
  "--builder-repair-gate",
  "--builder-repair-gate-timeout-ms",
  "--ticket-fix",
  "--ticket-fix-timeout-ms",
  "--ticket-fix-gate",
  "--ticket-fix-gate-timeout-ms",
  "--ticket-validate",
  "--ticket-validate-timeout-ms",
  "--ticket-validate-gate",
  "--ticket-validate-gate-timeout-ms",
  "--ticket-max-attempts",
  "--ticket-gate",
  "--ticket-gate-timeout-ms",
]);

/** The gate-id and gate-timeout-ms flags, each landing on a GatedPassBag or on TicketBag's own top-level pocket (the produce:false judgement pass). */
const GATE_FLAGS = new Set([
  "--builder-gate",
  "--builder-gate-timeout-ms",
  "--builder-repair-gate",
  "--builder-repair-gate-timeout-ms",
  "--ticket-gate",
  "--ticket-gate-timeout-ms",
  "--ticket-fix-gate",
  "--ticket-fix-gate-timeout-ms",
  "--ticket-validate-gate",
  "--ticket-validate-gate-timeout-ms",
]);

/** Flags that take a command after `--`, and where each one lands. */
const COMMAND_FLAGS = new Map<
  string,
  { stage: "builder"; pass: Pass } | "ticket-fix" | "ticket-validate"
>([
  ["--builder", { stage: "builder", pass: "producer" }],
  ["--builder-repair", { stage: "builder", pass: "repair" }],
  ["--ticket-fix", "ticket-fix"],
  ["--ticket-validate", "ticket-validate"],
]);

type Pass = "producer" | "repair";

export type ParseResult = { ok: true; invocation: HostInvocation } | { ok: false; reason: string };

export type ParseInput = {
  /** Where a relative flag path and the config search start. */
  cwd?: string;
  /**
   * Whether a named directory must already exist. `mason doctor` turns this
   * off so one missing path does not hide every other check.
   */
  checkPaths?: boolean;
};

type PassBag = { cmd?: string[]; timeoutMs?: number };

/** A pass with its own Gate pocket: `gates`, plus the one-shot staging field for `--*-gate-timeout-ms`. */
type GatedPassBag = PassBag & {
  gates: GateSpec[];
  /** Applies to the next Gate of this pass, so one ceiling per Gate is one flag. */
  nextGateTimeoutMs?: number;
};

type GatePocket = { gates: GateSpec[]; nextGateTimeoutMs?: number };

type StageBag = {
  producer: GatedPassBag;
  repair: GatedPassBag;
  maxAttempts?: number;
};

type TicketBag = {
  fix: GatedPassBag;
  validate: GatedPassBag;
  maxAttempts?: number;
  /** The produce:false judgement pass's own pocket — never shared with fix or validate. */
  gates: GateSpec[];
  nextGateTimeoutMs?: number;
};

type FlagBag = {
  configPath?: string;
  featureTracker?: string;
  featureTrackerOptions: Record<string, unknown>;
  ticketTracker?: string;
  ticketTrackerOptions: Record<string, unknown>;
  home?: string;
  workLineStable?: string;
  workLineBranch?: string;
  workLineIsolation?: string;
  workspaceRoot?: string;
  ledgerRoot?: string;
  persist?: string;
  builder: StageBag;
  ticket: TicketBag;
  timeoutMs?: number;
  pollIntervalMs?: number;
  streamsDir?: string;
};

function emptyGatedPass(): GatedPassBag {
  return { gates: [] };
}

function emptyStage(): StageBag {
  return { producer: emptyGatedPass(), repair: emptyGatedPass() };
}

function emptyTicket(): TicketBag {
  return { fix: emptyGatedPass(), validate: emptyGatedPass(), gates: [] };
}

/** Which bag a `--*-gate`/`--*-gate-timeout-ms` flag writes into. */
function gatePocket(bag: FlagBag, token: string): GatePocket {
  switch (token) {
    case "--builder-gate":
    case "--builder-gate-timeout-ms":
      return bag.builder.producer;
    case "--builder-repair-gate":
    case "--builder-repair-gate-timeout-ms":
      return bag.builder.repair;
    case "--ticket-gate":
    case "--ticket-gate-timeout-ms":
      return bag.ticket;
    case "--ticket-fix-gate":
    case "--ticket-fix-gate-timeout-ms":
      return bag.ticket.fix;
    default:
      // --ticket-validate-gate / --ticket-validate-gate-timeout-ms: the
      // only remaining member of GATE_FLAGS, by construction of its callers.
      return bag.ticket.validate;
  }
}

function takeValue(argv: string[], index: number): { value: string; next: number } | null {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    return null;
  }
  return { value, next: index + 2 };
}

function takeCommandArgv(
  argv: string[],
  start: number,
): { command: string[]; next: number } | null {
  if (argv[start] !== "--") {
    return null;
  }
  const command: string[] = [];
  let i = start + 1;
  while (i < argv.length) {
    const token = argv[i];
    if (token !== undefined && HOST_FLAGS.has(token)) {
      break;
    }
    if (token !== undefined) {
      command.push(token);
    }
    i += 1;
  }
  if (command.length === 0) {
    return null;
  }
  return { command, next: i };
}

function parsePositiveInt(raw: string): number | null {
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    return null;
  }
  return value;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** A repeated key collects into an array, which is how a list reaches a manager. */
function addManagerOption(
  options: Record<string, unknown>,
  raw: string,
  flag: string,
): { ok: true } | { ok: false; reason: string } {
  const separator = raw.indexOf("=");
  if (separator < 1) {
    return { ok: false, reason: `${flag} must be key=value.` };
  }
  const key = raw.slice(0, separator).trim();
  const value = raw.slice(separator + 1);
  if (key.length === 0) {
    return { ok: false, reason: `${flag} must be key=value.` };
  }
  const existing = options[key];
  if (existing === undefined) {
    options[key] = value;
  } else if (Array.isArray(existing)) {
    existing.push(value);
  } else {
    options[key] = [existing, value];
  }
  return { ok: true };
}

function parseFlags(argv: string[]): { ok: true; bag: FlagBag } | { ok: false; reason: string } {
  const bag: FlagBag = {
    featureTrackerOptions: {},
    ticketTrackerOptions: {},
    builder: emptyStage(),
    ticket: emptyTicket(),
  };
  let i = 0;
  while (i < argv.length) {
    const token = argv[i];
    if (token === undefined) {
      break;
    }

    const lands = COMMAND_FLAGS.get(token);
    if (lands !== undefined) {
      const command = takeCommandArgv(argv, i + 1);
      if (!command) {
        return { ok: false, reason: `Missing non-empty command after ${token} --.` };
      }
      if (lands === "ticket-fix") {
        bag.ticket.fix.cmd = command.command;
      } else if (lands === "ticket-validate") {
        bag.ticket.validate.cmd = command.command;
      } else {
        bag[lands.stage][lands.pass].cmd = command.command;
      }
      i = command.next;
      continue;
    }

    if (GATE_FLAGS.has(token) && !token.endsWith("-timeout-ms")) {
      const pocket = gatePocket(bag, token);
      const idTaken = takeValue(argv, i);
      if (!idTaken) {
        return { ok: false, reason: `Missing value for ${token}.` };
      }
      const command = takeCommandArgv(argv, idTaken.next);
      if (!command) {
        return { ok: false, reason: `Missing non-empty command after ${token} <id> --.` };
      }
      const timeoutMs = pocket.nextGateTimeoutMs;
      if (timeoutMs === undefined) {
        return {
          ok: false,
          reason: `${token} ${idTaken.value} has no ${token}-timeout-ms before it.`,
        };
      }
      pocket.gates.push({ id: idTaken.value, argv: command.command, timeoutMs });
      delete pocket.nextGateTimeoutMs;
      i = command.next;
      continue;
    }

    const taken = takeValue(argv, i);
    if (taken === null) {
      return { ok: false, reason: `Missing value for ${token}.` };
    }
    switch (token) {
      case "--config":
        bag.configPath = taken.value;
        break;
      case "--feature-tracker":
        bag.featureTracker = taken.value;
        break;
      case "--feature-tracker-option": {
        const added = addManagerOption(bag.featureTrackerOptions, taken.value, token);
        if (!added.ok) {
          return added;
        }
        break;
      }
      case "--ticket-tracker":
        bag.ticketTracker = taken.value;
        break;
      case "--ticket-tracker-option": {
        const added = addManagerOption(bag.ticketTrackerOptions, taken.value, token);
        if (!added.ok) {
          return added;
        }
        break;
      }
      case "--home":
        bag.home = taken.value;
        break;
      case "--work-line-stable":
        bag.workLineStable = taken.value;
        break;
      case "--work-line-branch":
        bag.workLineBranch = taken.value;
        break;
      case "--work-line-isolation":
        if (taken.value.length === 0) {
          return {
            ok: false,
            reason:
              "--work-line-isolation must be a non-empty package name or path that exports strategy.",
          };
        }
        bag.workLineIsolation = taken.value;
        break;
      case "--workspace-root":
        bag.workspaceRoot = taken.value;
        break;
      case "--ledger":
        bag.ledgerRoot = taken.value;
        break;
      // Naming the directory is what turns filming on. There is no bare
      // `--streams`: what a stream holds is the Project's own material in the
      // clear, and saying where it lands is part of asking for it.
      case "--streams-dir":
        if (taken.value.length === 0) {
          return { ok: false, reason: "--streams-dir must be a non-empty directory path." };
        }
        bag.streamsDir = taken.value;
        break;
      case "--persist":
        if (taken.value.length === 0) {
          return {
            ok: false,
            reason: "--persist must be a non-empty package name or path that exports openPersist.",
          };
        }
        bag.persist = taken.value;
        break;
      case "--timeout-ms": {
        const value = parsePositiveInt(taken.value);
        if (value === null) {
          return { ok: false, reason: "--timeout-ms must be a positive integer." };
        }
        bag.timeoutMs = value;
        break;
      }
      case "--builder-timeout-ms":
      case "--builder-repair-timeout-ms":
      case "--builder-max-attempts":
      case "--builder-gate-timeout-ms":
      case "--builder-repair-gate-timeout-ms":
      case "--ticket-fix-timeout-ms":
      case "--ticket-fix-gate-timeout-ms":
      case "--ticket-validate-timeout-ms":
      case "--ticket-validate-gate-timeout-ms":
      case "--ticket-max-attempts":
      case "--ticket-gate-timeout-ms": {
        const value = parsePositiveInt(taken.value);
        if (value === null) {
          return { ok: false, reason: `${token} must be a positive integer.` };
        }
        switch (token) {
          case "--builder-timeout-ms":
            bag.builder.producer.timeoutMs = value;
            break;
          case "--builder-repair-timeout-ms":
            bag.builder.repair.timeoutMs = value;
            break;
          case "--builder-max-attempts":
            bag.builder.maxAttempts = value;
            break;
          case "--ticket-fix-timeout-ms":
            bag.ticket.fix.timeoutMs = value;
            break;
          case "--ticket-validate-timeout-ms":
            bag.ticket.validate.timeoutMs = value;
            break;
          case "--ticket-max-attempts":
            bag.ticket.maxAttempts = value;
            break;
          default:
            // The six --*-gate-timeout-ms flags: each a one-shot ceiling
            // staged on its own GatedPassBag/TicketBag pocket.
            gatePocket(bag, token).nextGateTimeoutMs = value;
            break;
        }
        break;
      }
      case "--poll-interval-ms": {
        const value = parsePositiveInt(taken.value);
        if (value === null) {
          return { ok: false, reason: "--poll-interval-ms must be a positive integer." };
        }
        bag.pollIntervalMs = value;
        break;
      }
      default:
        return { ok: false, reason: `Unknown argument "${token}".` };
    }
    i = taken.next;
  }
  return { ok: true, bag };
}

function overlay(base: HostDraft, bag: FlagBag, cwd: string): HostDraft {
  const merged: HostDraft = { ...base };
  for (const side of ["featureTracker", "ticketTracker"] as const) {
    const name = bag[side];
    const options = bag[`${side}Options`];
    const spec = { ...base[side] };
    if (name !== undefined) {
      spec.package = name;
    }
    // Per key: overriding one option must not drop the rest of the config's.
    if (Object.keys(options).length > 0) {
      spec.options = { ...(base[side]?.options ?? {}), ...options };
    }
    if (Object.keys(spec).length > 0) {
      merged[side] = spec;
    }
  }
  if (bag.home !== undefined) {
    merged.home = resolve(cwd, bag.home);
  }
  if (bag.workLineStable !== undefined) {
    merged.workLineStable = resolve(cwd, bag.workLineStable);
  }
  if (bag.streamsDir !== undefined) {
    merged.observability = {
      ...(base.observability ?? {}),
      streams: {
        ...(base.observability?.streams ?? {}),
        enabled: true,
        dir: resolve(cwd, bag.streamsDir),
      },
    };
  }
  if (bag.workLineBranch !== undefined) {
    merged.workLineBranch = bag.workLineBranch;
  }
  if (bag.workLineIsolation !== undefined) {
    merged.workLineIsolation = bag.workLineIsolation;
  }
  if (bag.workspaceRoot !== undefined) {
    merged.workspaceRoot = resolve(cwd, bag.workspaceRoot);
  }
  if (bag.ledgerRoot !== undefined) {
    merged.ledgerRoot = resolve(cwd, bag.ledgerRoot);
  }
  if (bag.persist !== undefined) {
    merged.persist = bag.persist;
  }
  const builder = overlayBuilder(merged.builder, bag.builder);
  if (builder !== undefined) {
    merged.builder = builder;
  }
  const ticket = overlayTicket(merged.ticket, bag.ticket);
  if (ticket !== undefined) {
    merged.ticket = ticket;
  }
  if (bag.timeoutMs !== undefined) {
    merged.timeoutMs = bag.timeoutMs;
  }
  if (bag.pollIntervalMs !== undefined) {
    merged.pollIntervalMs = bag.pollIntervalMs;
  }
  return merged;
}

/**
 * A flag replaces the half of a pass it names, and leaves the other half alone.
 *
 * This is the one place a value is taken from somewhere else, and it is the
 * documented rule of the CLI: flags override the file. Nothing here lets one
 * pass borrow another pass's command.
 */
function overlayPass(base: PassSpec | undefined, bag: PassBag): PassSpec | undefined {
  const cmd = bag.cmd ?? base?.cmd;
  const timeoutMs = bag.timeoutMs ?? base?.timeoutMs;
  if (cmd === undefined || timeoutMs === undefined) {
    return base;
  }
  return { cmd, timeoutMs };
}

/** CLI flags replace a Gate list wholesale — never merged item-by-item with the file's. */
function overlayGates(base: readonly GateSpec[] | undefined, bag: GatePocket): GateSpec[] {
  return bag.gates.length > 0 ? bag.gates : [...(base ?? [])];
}

function overlayGatedPass(
  base: GatedPassSpec | undefined,
  bag: GatedPassBag,
): GatedPassSpec | undefined {
  const pass = overlayPass(base, bag);
  if (pass === undefined) {
    return base;
  }
  return { ...pass, gates: overlayGates(base?.gates, bag) };
}

/**
 * A review with no agent keeps its Gates; flags that name an agent make it a
 * review with one. Gate flags replace the Gate list wholesale, as everywhere.
 */
function overlayReview(base: ReviewSpec | undefined, bag: GatedPassBag): ReviewSpec | undefined {
  if (base !== undefined && !hasAgent(base)) {
    if (bag.cmd === undefined) {
      return { agent: false, gates: overlayGates(base.gates, bag) };
    }
    return overlayGatedPass(undefined, bag);
  }
  return overlayGatedPass(base, bag);
}

function overlayBuilder(
  base: HostInvocation["builder"] | undefined,
  bag: StageBag,
): HostInvocation["builder"] | undefined {
  const producer = overlayGatedPass(base?.producer, bag.producer);
  const repair = overlayGatedPass(base?.repair, bag.repair);
  const maxAttempts = bag.maxAttempts ?? base?.maxAttempts;
  if (producer === undefined && repair === undefined && maxAttempts === undefined) {
    return base;
  }
  if (producer === undefined || repair === undefined) {
    return base;
  }
  return {
    ...(base?.tests === undefined ? {} : { tests: base.tests }),
    producer,
    repair,
    ...(maxAttempts === undefined ? {} : { maxAttempts }),
  };
}

function overlayTicket(base: TicketSpec | undefined, bag: TicketBag): TicketSpec | undefined {
  const fix = overlayGatedPass(base?.fix, bag.fix);
  const validate = overlayReview(base?.validate, bag.validate);
  const maxAttempts = bag.maxAttempts ?? base?.maxAttempts;
  const gates = overlayGates(base?.gates, bag);
  if (
    fix === undefined &&
    validate === undefined &&
    maxAttempts === undefined &&
    gates.length === 0
  ) {
    return base;
  }
  return {
    ...(base?.maxParallel === undefined ? {} : { maxParallel: base.maxParallel }),
    ...(base?.maxRefusals === undefined ? {} : { maxRefusals: base.maxRefusals }),
    ...(fix === undefined ? {} : { fix }),
    ...(validate === undefined ? {} : { validate }),
    ...(maxAttempts === undefined ? {} : { maxAttempts }),
    gates,
  };
}

/**
 * Parse `mason run` argv (without node/script/`run`).
 *
 * The nearest `mason.config.json` is read when `--config` is absent, so a
 * project that has one needs no flag at all. Flags override the file.
 */
export function parseArgs(argv: string[], input: ParseInput = {}): ParseResult {
  const cwd = input.cwd ?? process.cwd();
  const flags = parseFlags(argv);
  if (!flags.ok) {
    return flags;
  }

  const configPath = flags.bag.configPath ?? findConfig(cwd);
  let base: HostDraft = { configDir: cwd };
  if (configPath !== undefined) {
    const loaded = loadConfig(resolve(cwd, configPath));
    if (!loaded.ok) {
      return loaded;
    }
    base = loaded.invocation;
  }

  return finalize(overlay(base, flags.bag, cwd), cwd, input.checkPaths ?? true);
}

function finalize(merged: HostDraft, cwd: string, checkPaths: boolean): ParseResult {
  const featurePackage = merged.featureTracker?.package;
  if (featurePackage === undefined) {
    return {
      ok: false,
      reason:
        'Missing required "featureTracker.package". Name a package that exports createManager.',
    };
  }
  const ticketPackage = merged.ticketTracker?.package;
  if (ticketPackage === undefined) {
    return {
      ok: false,
      reason:
        'Missing required "ticketTracker.package". Name a package that exports createManager.',
    };
  }
  if (merged.workLineIsolation === undefined) {
    return {
      ok: false,
      reason: `Missing required "workLine.isolation". Set it to a package name or path that exports strategy (e.g. "${ISOLATION_GIT}").`,
    };
  }
  if (merged.builder?.producer === undefined) {
    return { ok: false, reason: "Missing required --builder -- <argv…> and --builder-timeout-ms." };
  }
  if (merged.builder.repair === undefined) {
    return {
      ok: false,
      reason:
        "Missing required --builder-repair -- <argv…> and --builder-repair-timeout-ms. " +
        "A refused pass runs its own agent; it never reuses the first one.",
    };
  }
  if (merged.timeoutMs === undefined) {
    return { ok: false, reason: "Missing required --timeout-ms." };
  }
  if (merged.authority?.enabled === true && merged.feature === undefined) {
    return {
      ok: false,
      reason:
        'Missing required "feature" (its "gates" and its "fix"). With an Authority, a Feature\'s line is judged and repaired by its own config before it is folded.',
    };
  }

  const stable =
    merged.workLineStable === undefined ? undefined : resolve(cwd, merged.workLineStable);
  if (stable !== undefined && checkPaths && (!existsSync(stable) || !isDirectory(stable))) {
    return { ok: false, reason: `--work-line-stable is not an existing directory: ${stable}` };
  }
  const home = homeOf(cwd, merged.home);
  const workspaceRoot = resolve(cwd, merged.workspaceRoot ?? inHome(home, "workspaces"));
  if (checkPaths && existsSync(workspaceRoot) && !isDirectory(workspaceRoot)) {
    return { ok: false, reason: `--workspace-root is not a directory: ${workspaceRoot}` };
  }

  const invocation: HostInvocation = {
    featureTracker: { package: featurePackage, options: merged.featureTracker?.options ?? {} },
    ticketTracker: { package: ticketPackage, options: merged.ticketTracker?.options ?? {} },
    configDir: merged.configDir ?? cwd,
    home,
    workLineIsolation: merged.workLineIsolation,
    ...(merged.workLineIsolationOptions === undefined
      ? {}
      : { workLineIsolationOptions: merged.workLineIsolationOptions }),
    ...(merged.workLineWarm === undefined ? {} : { workLineWarm: merged.workLineWarm }),
    workspaceRoot,
    ledgerRoot: resolve(cwd, merged.ledgerRoot ?? inHome(home, "ledger")),
    persist: merged.persist ?? DEFAULT_PERSIST,
    builder: merged.builder,
    ticket: merged.ticket ?? { gates: [] },
    timeoutMs: merged.timeoutMs,
  };
  if (merged.feature !== undefined) {
    invocation.feature = merged.feature;
  }
  if (stable !== undefined) {
    invocation.workLineStable = stable;
  }
  if (merged.workLineTargetStable !== undefined) {
    invocation.workLineTargetStable = resolve(cwd, merged.workLineTargetStable);
  }
  if (merged.workLineBranch !== undefined) {
    invocation.workLineBranch = merged.workLineBranch;
  }
  if (merged.authority !== undefined) {
    invocation.authority = merged.authority;
  }
  if (merged.observability !== undefined) {
    invocation.observability = merged.observability;
  }
  if (merged.pollIntervalMs !== undefined) {
    invocation.pollIntervalMs = merged.pollIntervalMs;
  }
  return { ok: true, invocation };
}
