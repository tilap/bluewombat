import type { Aggregate, Summary } from "../records.js";

export type PersistSaveResult = { ok: true } | { ok: false; detail: string };

export type PersistencePort = {
  load(key: string): Promise<Aggregate | undefined>;
  save(key: string, aggregate: Aggregate): Promise<PersistSaveResult>;
  listSummaries(): Promise<Summary[]>;
};
