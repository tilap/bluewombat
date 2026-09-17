import type { FeatureAggregate, FeatureSummary } from "../records.js";

export type PersistSaveResult = { ok: true } | { ok: false; detail: string };

export type PersistencePort = {
  load(key: string): Promise<FeatureAggregate | undefined>;
  save(key: string, aggregate: FeatureAggregate): Promise<PersistSaveResult>;
  listSummaries(): Promise<FeatureSummary[]>;
};
