import type { PersistencePort } from "@bluewombat/work-ledger";
import { openFilesystemPersist } from "./open-filesystem-persist.js";

/**
 * The face Host loads by name (`"persist": "@bluewombat/persist-fs"`): the
 * ledger directory in, a Port out. One JSON file per key, directly under it.
 */
export function openPersist(context: { ledgerRoot: string }): Promise<PersistencePort> {
  return openFilesystemPersist({ root: context.ledgerRoot });
}
