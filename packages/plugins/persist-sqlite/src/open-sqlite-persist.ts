import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  Aggregate,
  PersistencePort,
  PersistSaveResult,
  Summary,
} from "@bluewombat/work-ledger";
import { isFeatureAggregate } from "@bluewombat/work-ledger";

export type SqlitePersistOptions = {
  path: string;
};

function isAggregate(value: unknown): value is Aggregate {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.state === "string" &&
    record.intention !== null &&
    typeof record.intention === "object"
  );
}

function toSummary(aggregate: Aggregate): Summary {
  if (isFeatureAggregate(aggregate)) {
    return {
      kind: "feature",
      key: aggregate.intention.key,
      project: aggregate.intention.project,
      state: aggregate.state,
      priority: aggregate.intention.priority,
      received_at: aggregate.received_at,
    };
  }
  const summary: Summary = {
    key: aggregate.intention.key,
    project: aggregate.intention.project,
    state: aggregate.state,
    priority: aggregate.intention.priority,
    received_at: aggregate.received_at,
  };
  if (aggregate.bail !== undefined) {
    summary.bail_expires_at = aggregate.bail.expires_at;
  }
  if (aggregate.intention.feature !== undefined) {
    summary.feature = aggregate.intention.feature;
  }
  return summary;
}

function parsePayload(raw: string): Aggregate | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isAggregate(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * SQLite Persistence Port. One row per key. A transaction wraps each save.
 * Does not know TicketStandard transitions.
 */
export async function openSqlitePersist(options: SqlitePersistOptions): Promise<PersistencePort> {
  if (!isAbsolute(options.path)) {
    throw new Error(`SQLite persist path must be an absolute file path, got "${options.path}".`);
  }
  await mkdir(dirname(options.path), { recursive: true });
  const db = new DatabaseSync(options.path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS tickets (
      key TEXT PRIMARY KEY NOT NULL,
      payload TEXT NOT NULL
    );
  `);

  const loadStmt = db.prepare("SELECT payload FROM tickets WHERE key = ?");
  const saveStmt = db.prepare("INSERT OR REPLACE INTO tickets (key, payload) VALUES (?, ?)");
  const listStmt = db.prepare("SELECT payload FROM tickets");

  return {
    async load(key: string): Promise<Aggregate | undefined> {
      const row = loadStmt.get(key) as { payload: string } | undefined;
      if (row === undefined) {
        return undefined;
      }
      return parsePayload(row.payload);
    },

    async save(key: string, aggregate: Aggregate): Promise<PersistSaveResult> {
      try {
        db.exec("BEGIN IMMEDIATE");
        saveStmt.run(key, JSON.stringify(aggregate));
        db.exec("COMMIT");
        return { ok: true };
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // Rollback can fail if BEGIN never succeeded.
        }
        const detail = error instanceof Error ? error.message : String(error);
        return { ok: false, detail };
      }
    },

    async listSummaries(): Promise<Summary[]> {
      const rows = listStmt.all() as { payload: string }[];
      const summaries: Summary[] = [];
      for (const row of rows) {
        const aggregate = parsePayload(row.payload);
        if (aggregate !== undefined) {
          summaries.push(toSummary(aggregate));
        }
      }
      return summaries;
    },
  };
}
