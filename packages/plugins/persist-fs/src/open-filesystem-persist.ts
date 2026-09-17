import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type {
  FeatureAggregate,
  FeatureSummary,
  PersistencePort,
  PersistSaveResult,
} from "@bluewombat/work-ledger";

export type FilesystemPersistOptions = {
  root: string;
};

function fileNameFor(key: string): string {
  return `${encodeURIComponent(key)}.json`;
}

function isAggregate(value: unknown): value is FeatureAggregate {
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

function toSummary(aggregate: FeatureAggregate): FeatureSummary {
  const summary: FeatureSummary = {
    key: aggregate.intention.key,
    project: aggregate.intention.project,
    state: aggregate.state,
    priority: aggregate.intention.priority,
    received_at: aggregate.received_at,
  };
  if (aggregate.bail !== undefined) {
    summary.bail_expires_at = aggregate.bail.expires_at;
  }
  return summary;
}

/**
 * Filesystem Persistence Port. One JSON file per key. Atomic rename on save.
 * Does not know FeatureStandard transitions.
 */
export async function openFilesystemPersist(
  options: FilesystemPersistOptions,
): Promise<PersistencePort> {
  if (!isAbsolute(options.root)) {
    throw new Error(
      `Filesystem persist root must be an absolute directory, got "${options.root}".`,
    );
  }
  await mkdir(options.root, { recursive: true });
  const root = options.root;

  return {
    async load(key: string): Promise<FeatureAggregate | undefined> {
      const path = join(root, fileNameFor(key));
      try {
        const raw = await readFile(path, "utf8");
        const parsed: unknown = JSON.parse(raw);
        if (!isAggregate(parsed)) {
          return undefined;
        }
        return parsed;
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          return undefined;
        }
        throw error;
      }
    },

    async save(key: string, aggregate: FeatureAggregate): Promise<PersistSaveResult> {
      const target = join(root, fileNameFor(key));
      const temporary = join(root, `.${fileNameFor(key)}.tmp`);
      try {
        await writeFile(temporary, `${JSON.stringify(aggregate)}\n`, "utf8");
        await rename(temporary, target);
        return { ok: true };
      } catch (error) {
        try {
          await unlink(temporary);
        } catch {
          // Best-effort cleanup of a leftover temporary file.
        }
        const detail = error instanceof Error ? error.message : String(error);
        return { ok: false, detail };
      }
    },

    async listSummaries(): Promise<FeatureSummary[]> {
      const names = await readdir(root);
      const summaries: FeatureSummary[] = [];
      for (const name of names) {
        if (!name.endsWith(".json") || name.startsWith(".")) {
          continue;
        }
        try {
          const raw = await readFile(join(root, name), "utf8");
          const parsed: unknown = JSON.parse(raw);
          if (isAggregate(parsed)) {
            summaries.push(toSummary(parsed));
          }
        } catch {}
      }
      return summaries;
    },
  };
}
