import type { PersistencePort } from "@bluewombat/work-ledger";
import { loadPlugin, type Shape } from "./load.js";

/**
 * How the ledger is stored. The Port is `@bluewombat/work-ledger`'s; what a
 * backend package exports to hand one over is fixed here: `openPersist`,
 * given the directory Host keeps its ledger in. Where inside that directory
 * the bytes go — one file per key, one SQLite file — is the backend's.
 */
export type PersistContext = {
  /** Absolute. Host's own; the backend writes under it. */
  ledgerRoot: string;
};

export type PersistModule = {
  openPersist(context: PersistContext): Promise<PersistencePort>;
};

const persistShape: Shape<PersistModule> = {
  kind: "Persistence backend",
  check(loaded) {
    if (
      loaded === null ||
      typeof loaded !== "object" ||
      typeof (loaded as { openPersist?: unknown }).openPersist !== "function"
    ) {
      return { ok: false, reason: "does not export openPersist" };
    }
    return { ok: true, value: loaded as PersistModule };
  },
};

export type ResolvePersistResult =
  | { ok: true; module: PersistModule; specifier: string }
  | { ok: false; reason: string };

/** Load the persistence backend named by `persist`. */
export async function resolvePersistModule(
  name: string,
  fromDir: string,
): Promise<ResolvePersistResult> {
  const loaded = await loadPlugin(name, fromDir, persistShape);
  return loaded.ok ? { ok: true, module: loaded.value, specifier: loaded.specifier } : loaded;
}

/** Resolve the backend, then open the Port under `ledgerRoot`. */
export async function openPersist(
  name: string,
  fromDir: string,
  ledgerRoot: string,
): Promise<{ ok: true; persist: PersistencePort } | { ok: false; reason: string }> {
  const resolved = await resolvePersistModule(name, fromDir);
  if (!resolved.ok) {
    return resolved;
  }
  return { ok: true, persist: await resolved.module.openPersist({ ledgerRoot }) };
}
