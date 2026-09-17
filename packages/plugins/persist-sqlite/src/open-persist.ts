import { join } from "node:path";
import type { PersistencePort } from "@bluewombat/work-ledger";
import { openSqlitePersist } from "./open-sqlite-persist.js";

/** The one file the ledger lives in, under Host's ledger directory. */
export const LEDGER_FILE = "ledger.sqlite";

/**
 * The face Host loads by name (`"persist": "@bluewombat/persist-sqlite"`):
 * the ledger directory in, a Port out. Everything goes in `ledger.sqlite`
 * there; Host's own files (Cursor, journal, lock) sit beside it untouched.
 */
export function openPersist(context: { ledgerRoot: string }): Promise<PersistencePort> {
  return openSqlitePersist({ path: join(context.ledgerRoot, LEDGER_FILE) });
}
