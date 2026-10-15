import type {
  FeatureTrackerPort,
  Manager,
  ManagerContext,
  ManagerModule,
  ManagerSide,
  TicketTrackerPort,
} from "@bluewombat/manager-kit";
import type { ManagerSpec } from "../config/types.js";
import { loadPlugin, type Shape } from "./load.js";

/** The module face a manager package must export. Contract: `@bluewombat/manager-kit`. */
const managerShape: Shape<ManagerModule> = {
  kind: "Manager",
  check(loaded) {
    if (
      loaded === null ||
      typeof loaded !== "object" ||
      typeof (loaded as { createManager?: unknown }).createManager !== "function"
    ) {
      return { ok: false, reason: "does not export createManager" };
    }
    return { ok: true, value: loaded as ManagerModule };
  },
};

export type ResolveResult =
  | { ok: true; module: ManagerModule; specifier: string }
  | { ok: false; reason: string };

/** Load the manager package named by the config. */
export async function resolveManagerModule(name: string, fromDir: string): Promise<ResolveResult> {
  const loaded = await loadPlugin(name, fromDir, managerShape);
  return loaded.ok ? { ok: true, module: loaded.value, specifier: loaded.specifier } : loaded;
}

export type ManagerRequest = {
  manager: string | ManagerModule;
  managerOptions: Record<string, unknown>;
  configDir: string;
  durationMs: number;
  interruptFlag: { interrupted: boolean };
  env: Record<string, string | undefined>;
  /** The sides this manager is built for; absent means both. */
  sides?: readonly Side[];
};

export type LoadedModule = { ok: true; module: ManagerModule } | { ok: false; reason: string };

export function contextOf(request: ManagerRequest): ManagerContext {
  return {
    options: request.managerOptions,
    durationMs: request.durationMs,
    interruptFlag: request.interruptFlag,
    configDir: request.configDir,
    env: request.env,
    ...(request.sides !== undefined ? { sides: request.sides } : {}),
  };
}

/** The module face, so `mason doctor` can ask a manager to check itself. */
export async function loadManagerModule(request: ManagerRequest): Promise<LoadedModule> {
  if (typeof request.manager !== "string") {
    return { ok: true, module: request.manager };
  }
  const resolved = await resolveManagerModule(request.manager, request.configDir);
  return resolved.ok ? { ok: true, module: resolved.module } : resolved;
}

/**
 * Resolve the manager package, then let it build its own Port. Host reads
 * neither the options nor the environment on its behalf.
 */
export async function openManager(
  request: ManagerRequest,
): Promise<{ ok: true; manager: Manager } | { ok: false; reason: string }> {
  const loaded = await loadManagerModule(request);
  if (!loaded.ok) {
    return loaded;
  }
  return await loaded.module.createManager(contextOf(request));
}

export type Side = ManagerSide;

export type ManagerSides = Record<Side, ManagerSpec<string | ManagerModule>>;

export type DistinctManager = {
  /** The sides this one manager answers: both when the config names it twice alike. */
  sides: Side[];
  spec: ManagerSpec<string | ManagerModule>;
};

/**
 * The managers behind the two sides. One package with one set of options is one
 * manager, built once, so a tracker that holds both is not read through two
 * clients.
 */
export function distinctManagers(sides: ManagerSides): DistinctManager[] {
  const { featureTracker, ticketTracker } = sides;
  if (
    featureTracker.package === ticketTracker.package &&
    JSON.stringify(featureTracker.options) === JSON.stringify(ticketTracker.options)
  ) {
    return [{ sides: ["featureTracker", "ticketTracker"], spec: featureTracker }];
  }
  return [
    { sides: ["featureTracker"], spec: featureTracker },
    { sides: ["ticketTracker"], spec: ticketTracker },
  ];
}

/** What a side is called in a message a person reads. */
export function nameOfSides(sides: Side[]): string {
  return sides.length === 2
    ? "feature tracker and ticket tracker"
    : sides[0] === "featureTracker"
      ? "feature tracker"
      : "ticket tracker";
}

export function requestOf(
  spec: ManagerSpec<string | ManagerModule>,
  common: Omit<ManagerRequest, "manager" | "managerOptions" | "sides">,
  sides?: readonly Side[],
): ManagerRequest {
  return {
    ...common,
    manager: spec.package,
    managerOptions: spec.options,
    ...(sides !== undefined ? { sides } : {}),
  };
}

/**
 * Build the Port of each side. A package asked for a side it does not answer
 * is refused by name: a run needs Features to read and Tickets to make.
 */
export async function openManagers(
  sides: ManagerSides,
  common: Omit<ManagerRequest, "manager" | "managerOptions" | "sides">,
): Promise<
  | { ok: true; features: FeatureTrackerPort; tickets: TicketTrackerPort }
  | { ok: false; reason: string }
> {
  const built: Partial<Record<Side, Manager>> = {};
  for (const one of distinctManagers(sides)) {
    const opened = await openManager(requestOf(one.spec, common, one.sides));
    if (!opened.ok) {
      return opened;
    }
    for (const side of one.sides) {
      built[side] = opened.manager;
    }
  }
  const features = built.featureTracker?.features;
  if (features === undefined) {
    return {
      ok: false,
      reason: `${nameOf(sides.featureTracker)} answers no FeatureTracker, and "featureTracker" must name a package that does.`,
    };
  }
  const tickets = built.ticketTracker?.tickets;
  if (tickets === undefined) {
    return {
      ok: false,
      reason: `${nameOf(sides.ticketTracker)} answers no TicketTracker, and "ticketTracker" must name a package that does.`,
    };
  }
  return { ok: true, features, tickets };
}

function nameOf(spec: ManagerSpec<string | ManagerModule>): string {
  return typeof spec.package === "string" ? spec.package : "the manager";
}
