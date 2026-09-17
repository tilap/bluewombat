import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { GateSpec } from "@bluewombat/implementer";
import { DEFAULT_PERSIST, ISOLATION_GIT } from "./defaults.js";
import { findConfig } from "./find-config.js";
import { homeOf, inHome } from "./home.js";
import { loadConfig } from "./load-config.js";
import type { AssemblySpec, HostInvocation, PassSpec } from "./types.js";

const HOST_FLAGS = new Set([
  "--config",
  "--manager",
  "--manager-option",
  "--home",
  "--work-line-stable",
  "--work-line-branch",
  "--work-line-isolation",
  "--workspace-root",
  "--ledger",
  "--persist",
  "--timeout-ms",
  "--poll-interval-ms",
  "--planner",
  "--planner-timeout-ms",
  "--builder",
  "--builder-timeout-ms",
  "--builder-max-attempts",
  "--builder-repair",
  "--builder-repair-timeout-ms",
  "--builder-gate",
  "--builder-gate-timeout-ms",
  "--assembly-fix",
  "--assembly-fix-timeout-ms",
  "--assembly-max-attempts",
  "--assembly-gate",
  "--assembly-gate-timeout-ms",
]);

/** Flags that take a command after `--`, and where each one lands. */
const COMMAND_FLAGS = new Map<
  string,
  { stage: "builder"; pass: Pass } | "planner" | "assembly-fix"
>([
  ["--planner", "planner"],
  ["--builder", { stage: "builder", pass: "producer" }],
  ["--builder-repair", { stage: "builder", pass: "repair" }],
  ["--assembly-fix", "assembly-fix"],
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

type StageBag = {
  producer: PassBag;
  repair: PassBag;
  maxAttempts?: number;
  gates: GateSpec[];
  /** Applies to the next gate of this stage, so one ceiling per Gate is one flag. */
  nextGateTimeoutMs?: number;
};

type AssemblyBag = {
  fix: PassBag;
  maxAttempts?: number;
  gates: GateSpec[];
  nextGateTimeoutMs?: number;
};

type FlagBag = {
  configPath?: string;
  manager?: string;
  managerOptions: Record<string, unknown>;
  home?: string;
  workLineStable?: string;
  workLineBranch?: string;
  workLineIsolation?: string;
  workspaceRoot?: string;
  ledgerRoot?: string;
  persist?: string;
  planner: PassBag;
  builder: StageBag;
  assembly: AssemblyBag;
  timeoutMs?: number;
  pollIntervalMs?: number;
};

function emptyStage(): StageBag {
  return { producer: {}, repair: {}, gates: [] };
}

function emptyAssembly(): AssemblyBag {
  return { fix: {}, gates: [] };
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
): { ok: true } | { ok: false; reason: string } {
  const separator = raw.indexOf("=");
  if (separator < 1) {
    return { ok: false, reason: "--manager-option must be key=value." };
  }
  const key = raw.slice(0, separator).trim();
  const value = raw.slice(separator + 1);
  if (key.length === 0) {
    return { ok: false, reason: "--manager-option must be key=value." };
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
    managerOptions: {},
    planner: {},
    builder: emptyStage(),
    assembly: emptyAssembly(),
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
      if (lands === "planner") {
        bag.planner.cmd = command.command;
      } else if (lands === "assembly-fix") {
        bag.assembly.fix.cmd = command.command;
      } else {
        bag[lands.stage][lands.pass].cmd = command.command;
      }
      i = command.next;
      continue;
    }

    if (token === "--builder-gate" || token === "--assembly-gate") {
      const stage = token === "--builder-gate" ? "builder" : "assembly";
      const idTaken = takeValue(argv, i);
      if (!idTaken) {
        return { ok: false, reason: `Missing value for ${token}.` };
      }
      const command = takeCommandArgv(argv, idTaken.next);
      if (!command) {
        return { ok: false, reason: `Missing non-empty command after ${token} <id> --.` };
      }
      const timeoutMs = bag[stage].nextGateTimeoutMs;
      if (timeoutMs === undefined) {
        return {
          ok: false,
          reason: `${token} ${idTaken.value} has no ${token}-timeout-ms before it.`,
        };
      }
      bag[stage].gates.push({ id: idTaken.value, argv: command.command, timeoutMs });
      delete bag[stage].nextGateTimeoutMs;
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
      case "--manager":
        bag.manager = taken.value;
        break;
      case "--manager-option": {
        const added = addManagerOption(bag.managerOptions, taken.value);
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
      case "--planner-timeout-ms":
      case "--builder-timeout-ms":
      case "--builder-repair-timeout-ms":
      case "--builder-max-attempts":
      case "--builder-gate-timeout-ms":
      case "--assembly-fix-timeout-ms":
      case "--assembly-max-attempts":
      case "--assembly-gate-timeout-ms": {
        const value = parsePositiveInt(taken.value);
        if (value === null) {
          return { ok: false, reason: `${token} must be a positive integer.` };
        }
        switch (token) {
          case "--planner-timeout-ms":
            bag.planner.timeoutMs = value;
            break;
          case "--builder-timeout-ms":
            bag.builder.producer.timeoutMs = value;
            break;
          case "--builder-repair-timeout-ms":
            bag.builder.repair.timeoutMs = value;
            break;
          case "--builder-max-attempts":
            bag.builder.maxAttempts = value;
            break;
          case "--builder-gate-timeout-ms":
            bag.builder.nextGateTimeoutMs = value;
            break;
          case "--assembly-fix-timeout-ms":
            bag.assembly.fix.timeoutMs = value;
            break;
          case "--assembly-max-attempts":
            bag.assembly.maxAttempts = value;
            break;
          default:
            bag.assembly.nextGateTimeoutMs = value;
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

function overlay(
  base: Partial<HostInvocation>,
  bag: FlagBag,
  cwd: string,
): Partial<HostInvocation> {
  const merged: Partial<HostInvocation> = { ...base };
  if (bag.manager !== undefined) {
    merged.manager = bag.manager;
  }
  // Per key: overriding one option must not drop the rest of the config's.
  if (Object.keys(bag.managerOptions).length > 0) {
    merged.managerOptions = { ...(base.managerOptions ?? {}), ...bag.managerOptions };
  }
  if (bag.home !== undefined) {
    merged.home = resolve(cwd, bag.home);
  }
  if (bag.workLineStable !== undefined) {
    merged.workLineStable = resolve(cwd, bag.workLineStable);
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
  const planner = overlayPass(merged.planner, bag.planner);
  if (planner !== undefined) {
    merged.planner = planner;
  }
  const builder = overlayBuilder(merged.builder, bag.builder);
  if (builder !== undefined) {
    merged.builder = builder;
  }
  const assembly = overlayAssembly(merged.assembly, bag.assembly);
  if (assembly !== undefined) {
    merged.assembly = assembly;
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

function overlayBuilder(
  base: HostInvocation["builder"] | undefined,
  bag: StageBag,
): HostInvocation["builder"] | undefined {
  const producer = overlayPass(base?.producer, bag.producer);
  const repair = overlayPass(base?.repair, bag.repair);
  const maxAttempts = bag.maxAttempts ?? base?.maxAttempts;
  const gates = bag.gates.length > 0 ? bag.gates : (base?.gates ?? []);
  if (
    producer === undefined &&
    repair === undefined &&
    maxAttempts === undefined &&
    gates.length === 0
  ) {
    return base;
  }
  if (producer === undefined || repair === undefined) {
    return base;
  }
  return {
    producer,
    repair,
    ...(maxAttempts === undefined ? {} : { maxAttempts }),
    gates,
  };
}

function overlayAssembly(
  base: AssemblySpec | undefined,
  bag: AssemblyBag,
): AssemblySpec | undefined {
  const fix = overlayPass(base?.fix, bag.fix);
  const maxAttempts = bag.maxAttempts ?? base?.maxAttempts;
  const gates = bag.gates.length > 0 ? bag.gates : (base?.gates ?? []);
  if (fix === undefined && maxAttempts === undefined && gates.length === 0) {
    return base;
  }
  return {
    ...(fix === undefined ? {} : { fix }),
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
  let base: Partial<HostInvocation> = { configDir: cwd };
  if (configPath !== undefined) {
    const loaded = loadConfig(resolve(cwd, configPath));
    if (!loaded.ok) {
      return loaded;
    }
    base = loaded.invocation;
  }

  return finalize(overlay(base, flags.bag, cwd), cwd, input.checkPaths ?? true);
}

function finalize(merged: Partial<HostInvocation>, cwd: string, checkPaths: boolean): ParseResult {
  if (merged.manager === undefined) {
    return {
      ok: false,
      reason: 'Missing required "manager". Name a package that exports createManager.',
    };
  }
  if (merged.workLineIsolation === undefined) {
    return {
      ok: false,
      reason: `Missing required "workLine.isolation". Set it to a package name or path that exports strategy (e.g. "${ISOLATION_GIT}").`,
    };
  }
  if (merged.planner === undefined) {
    return { ok: false, reason: "Missing required --planner -- <argv…> and --planner-timeout-ms." };
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
    manager: merged.manager,
    managerOptions: merged.managerOptions ?? {},
    configDir: merged.configDir ?? cwd,
    home,
    workLineIsolation: merged.workLineIsolation,
    ...(merged.workLineIsolationOptions === undefined
      ? {}
      : { workLineIsolationOptions: merged.workLineIsolationOptions }),
    workspaceRoot,
    ledgerRoot: resolve(cwd, merged.ledgerRoot ?? inHome(home, "ledger")),
    persist: merged.persist ?? DEFAULT_PERSIST,
    planner: merged.planner,
    builder: merged.builder,
    assembly: merged.assembly ?? { gates: [] },
    timeoutMs: merged.timeoutMs,
  };
  if (stable !== undefined) {
    invocation.workLineStable = stable;
  }
  if (merged.workLineBranch !== undefined) {
    invocation.workLineBranch = merged.workLineBranch;
  }
  if (merged.authority !== undefined) {
    invocation.authority = merged.authority;
  }
  if (merged.maxRefusals !== undefined) {
    invocation.maxRefusals = merged.maxRefusals;
  }
  if (merged.pollIntervalMs !== undefined) {
    invocation.pollIntervalMs = merged.pollIntervalMs;
  }
  return { ok: true, invocation };
}
