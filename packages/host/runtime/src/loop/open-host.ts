import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openConductor } from "@bluewombat/conductor";
import { openWorkLedger } from "@bluewombat/work-ledger";
import { DEFAULT_PERSIST } from "../config/defaults.js";
import { homeOf } from "../config/home.js";
import type { HostOptions } from "../config/types.js";
import { resolveIsolationStrategy } from "../plugins/isolation.js";
import { contextOf, loadManagerModule, type ManagerRequest } from "../plugins/manager.js";
import { resolvePersistModule } from "../plugins/persist.js";
import { openAuthority } from "./authority.js";
import type { HostRunInput } from "./context.js";
import { cancelFeature } from "./deliveries.js";
import { coalesceQuiet, type Journal, openJournalFile, stampJournal } from "./journal.js";
import { acquireLock } from "./lock.js";
import { openStreams, type Streams } from "./streams.js";
import { type Host, run, runOnce } from "./tick.js";
import { openTrace } from "./trace.js";
import { createTransformers } from "./transformers.js";
import { inspectWorkLine, materializeWorkLine, resolveWorkLine } from "./work-line.js";

export type { HostOptions } from "../config/types.js";
export type { CancelResult } from "./deliveries.js";
export type { Host, HostTickResult } from "./tick.js";

const DEFAULT_MAX_UNITS = 10;
const DEFAULT_MAX_FEATURE_BYTES = 65_536;

/**
 * Which build of Host is running, for the line that opens the film.
 *
 * A global link and an installed copy answer the same command, and a run that
 * meant to exercise one can silently be the other. The version is the only
 * thing in the journal that tells them apart afterwards. Unknown rather than
 * fatal: a film is not worth failing a run over.
 */
function hostVersion(): string {
  try {
    const manifest = fileURLToPath(new URL("../../package.json", import.meta.url));
    const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
    const version = (parsed as { version?: unknown }).version;
    return typeof version === "string" ? version : "unknown";
  } catch {
    return "unknown";
  }
}

/** What a caller may hand `openHost` that is not configuration: a test's film. */
export type OpenHostDeps = {
  /** Film next to the ledger. Defaults to `<ledgerRoot>/events.jsonl`. */
  journal?: Journal;
};

export async function openHost(options: HostOptions, deps: OpenHostDeps = {}): Promise<Host> {
  const configDir = options.configDir ?? process.cwd();
  const home = homeOf(configDir, options.home);
  const interruptFlag = options.interruptFlag ?? { interrupted: false };
  const trace = openTrace(
    options.write ??
      ((text: string) => {
        process.stdout.write(text);
      }),
  );
  const resolved = await resolveIsolationStrategy(
    options.workLineIsolation,
    configDir,
    options.workLineIsolationOptions,
  );
  if (!resolved.ok) {
    throw new Error(resolved.reason);
  }
  const persistName = options.persist ?? DEFAULT_PERSIST;
  const backend = await resolvePersistModule(persistName, configDir);
  if (!backend.ok) {
    throw new Error(backend.reason);
  }
  const request: ManagerRequest = {
    manager: options.manager,
    managerOptions: options.managerOptions ?? {},
    configDir,
    durationMs: options.timeoutMs,
    interruptFlag,
    env: options.env ?? process.env,
  };
  const loaded = await loadManagerModule(request);
  if (!loaded.ok) {
    throw new Error(loaded.reason);
  }
  const managerName = typeof options.manager === "string" ? options.manager : "the manager";

  // Whose directory the work line is, settled before anything is written. A
  // reference the manager names is read by the strategy — strictly, since the
  // two agree on words nothing checks at compile time — and Host's copy of it
  // is fetched here, so a wrong key or an unreachable remote stops the run
  // now rather than in the middle of one.
  const workLine = resolveWorkLine({
    home,
    stable: options.workLineStable,
    branch: options.workLineBranch,
    manager: managerName,
    wantsAuthority: options.authority?.enabled === true,
    reference: loaded.module.referenceManager?.(contextOf(request)),
    strategy: resolved.strategy,
    strategyName: resolved.specifier,
  });
  if (workLine.kind === "invalid") {
    throw new Error(workLine.reason);
  }
  if (workLine.kind === "copy") {
    const made = await materializeWorkLine(workLine);
    if (!made.ok) {
      throw new Error(made.reason);
    }
    if (made.fetched) {
      trace(`work line  copied ${workLine.reference.summary} to ${workLine.stable}`);
    }
  }
  const stable = workLine.stable;
  // The reference's git environment: who the system is on the work line. Only
  // the slots that touch the work line get it; nothing else inherits it.
  const workLineEnv = workLine.kind === "copy" ? workLine.reference.env : undefined;
  const target = workLine.kind === "copy" ? workLine.target : options.workLineBranch;
  // Which work line a fold lands on is a decision, not an accident of what was
  // left checked out. Refuse before anything is written rather than fold onto
  // a branch nobody chose. (A copy was already held against its reference.)
  if (workLine.kind !== "copy" && target !== undefined) {
    const state = inspectWorkLine(stable);
    if (state.kind === "git" && state.branch !== target) {
      throw new Error(
        `WorkLineStable is on "${state.branch}", but the config wants "${target}". Switch it, or change workLine.branch.`,
      );
    }
  }

  await mkdir(options.workspaceRoot, { recursive: true });
  const release = await acquireLock(options.ledgerRoot);
  const persist = await backend.module.openPersist({ ledgerRoot: options.ledgerRoot });
  const ledger = openWorkLedger({ persist });
  // Every line this run writes carries the same `run_id`, so a reader can tell
  // one process's film from the one that wrote to this ledger before it.
  const runId = randomUUID();
  // Coalescing sits above the stamp: a heartbeat it writes is a line of this
  // run like any other, and must carry the run with it.
  const journal = coalesceQuiet(
    stampJournal(deps.journal ?? openJournalFile(options.ledgerRoot), { run_id: runId }),
  );
  journal.append({
    event: "host-started",
    pid: process.pid,
    version: hostVersion(),
    manager: managerName,
    ledger_root: options.ledgerRoot,
    ...(options.configDir === undefined ? {} : { config_dir: options.configDir }),
  });
  // Off unless the Project asked: what a stream holds is its own material in
  // the clear. `home` is where Host keeps what is its own, like the ledger.
  const streamsSpec = options.observability?.streams;
  const streams: Streams | undefined =
    streamsSpec?.enabled === true
      ? openStreams({
          dir: streamsSpec.dir ?? join(home, "streams"),
          keep: streamsSpec.keep ?? ["stdout", "stderr"],
          journal,
        })
      : undefined;
  const transformers = createTransformers({
    trace,
    journal,
    ...(streams === undefined ? {} : { streams }),
    planner: options.planner,
    builder: options.builder,
    assembly: options.assembly,
    isolation: resolved.strategy.isolation,
    fold: resolved.strategy.fold,
    timeoutMs: options.timeoutMs,
    maxUnits: DEFAULT_MAX_UNITS,
    maxFeatureBytes: DEFAULT_MAX_FEATURE_BYTES,
  });
  const hostOptions: HostOptions = { ...options, interruptFlag };
  const created = await loaded.module.createManager(contextOf(request));
  if (!created.ok) {
    throw new Error(created.reason);
  }
  const manager = created.manager;

  // Declared, never inferred: a Project has an Authority because it says so,
  // not because a directory happens to look a certain way. Disabled, the
  // assembled feature is folded into WorkLineStable and that fold is final.
  const wantsAuthority = options.authority?.enabled === true;
  if (wantsAuthority && target === undefined) {
    throw new Error(
      'authority.enabled is true, but "workLine.branch" does not say which work line the work is offered to.',
    );
  }
  const authority =
    wantsAuthority && options.authority !== undefined && target !== undefined
      ? openAuthority({
          manager,
          workLineStable: stable,
          workLineTarget: target,
          publishArgv: options.authority.publishArgv,
          timeoutMs: options.timeoutMs,
          refOf: resolved.strategy.refOf ?? ((id) => id),
          env: workLineEnv,
          describe:
            options.authority.describeArgv === undefined
              ? undefined
              : { cmd: options.authority.describeArgv, timeoutMs: options.timeoutMs },
          workspaceRoot: options.workspaceRoot,
          journal,
        })
      : undefined;
  // Asking for an Authority from a manager that has none is a configuration
  // mistake, not a reason to quietly fold locally instead.
  if (wantsAuthority && authority === undefined) {
    throw new Error(
      `${managerName} declares no Submission, so it cannot be an Authority. Set "authority.enabled" to false, or name a manager that submits and folds.`,
    );
  }
  // Conductor says what happens mid-pass; the tick that is running decides what
  // to do with it (report it), so the hook is a slot the tick fills.
  const watcher: HostRunInput["watcher"] = {};
  const conductor = openConductor({
    ledger,
    transformers,
    workLineStable: stable,
    workspaceRoot: options.workspaceRoot,
    transformerDurationMs: options.timeoutMs,
    observe: (moment) => watcher.current?.(moment),
    ...(authority === undefined ? {} : { authority }),
    ...(target === undefined ? {} : { workLineTarget: target }),
    ...(options.maxRefusals === undefined ? {} : { maxRefusals: options.maxRefusals }),
    assemblyValidate: options.assembly.validate !== undefined,
    assemblyFixDeclared: options.assembly.fix !== undefined,
  });

  const ctx: HostRunInput = {
    options: hostOptions,
    workLine: {
      stable,
      ...(target === undefined ? {} : { target }),
      ...(workLineEnv === undefined ? {} : { env: workLineEnv }),
    },
    ledger,
    conductor,
    manager,
    journal,
    ...(streams === undefined ? {} : { streams }),
    trace,
    watcher,
    said: new Set(),
    ...(authority === undefined ? {} : { authority }),
  };

  return {
    ledger,
    conductor,
    runOnce: () => runOnce(ctx),
    run: () => run(ctx),
    cancel: (key) => cancelFeature(ctx, key),
    // The film closes before the lock does: whoever reads it next has to be
    // able to tell a run that ended from one whose process was killed, and the
    // absence of this line is the only way to say the second.
    close: async () => {
      journal.append({ event: "host-stopped", pid: process.pid });
      await release();
    },
  };
}
