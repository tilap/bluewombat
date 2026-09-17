import type { ManagerContext, ManagerModule, ManagerPort } from "@bluewombat/manager-kit";
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
};

export type LoadedModule = { ok: true; module: ManagerModule } | { ok: false; reason: string };

export function contextOf(request: ManagerRequest): ManagerContext {
  return {
    options: request.managerOptions,
    durationMs: request.durationMs,
    interruptFlag: request.interruptFlag,
    configDir: request.configDir,
    env: request.env,
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
): Promise<{ ok: true; manager: ManagerPort } | { ok: false; reason: string }> {
  const loaded = await loadManagerModule(request);
  if (!loaded.ok) {
    return loaded;
  }
  return await loaded.module.createManager(contextOf(request));
}
