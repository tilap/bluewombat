import type { PersistencePort } from "../persist/port.js";
import type {
  Aggregate,
  FeatureAggregate,
  FeatureIntention,
  FeatureState,
  FeatureSummary,
} from "../records.js";
import { isFeatureAggregate, isFeatureSummary } from "../records.js";
import { type CommandResult, refused } from "./results.js";

/** States in which a Feature holds its Project: nothing else opens beside it. */
const HOLDING: ReadonlySet<FeatureState> = new Set(["open", "submitted", "escalated"]);

export type FeatureAdmission = FeatureIntention;

export type FeatureGetResult =
  | { ok: true; aggregate: FeatureAggregate }
  | { ok: false; code: "not-found" };

export type FeatureCommands = {
  /** Store a Feature as `waiting`. An edit while it waits replaces the intention; while it is held, it is recorded as pending. */
  admitFeature(feature: FeatureAdmission): Promise<CommandResult>;
  /** What would open next on the Project: waiting, every blocker `done`, highest priority then oldest. Nothing while the Project holds a Feature. */
  nextFeature(project: string): Promise<FeatureSummary | undefined>;
  /** `waiting` → `open`, with the line its Tickets land on (none without an Authority) and the keys of those Tickets. */
  openFeature(input: { key: string; line?: string; tickets: string[] }): Promise<CommandResult>;
  /** `open` → `submitted`: the line is with the Authority. */
  markFeatureSubmitted(input: { key: string; reference: string }): Promise<CommandResult>;
  /** The Authority's judgement sent the line back: `submitted` → `open`, with why, for the next fix. */
  recordFeatureRefusal(input: {
    key: string;
    report: string;
    refusedBy?: string;
  }): Promise<CommandResult>;
  /** The line it is offered to moved on: `submitted` → `open`, to be aligned again. No fix is owed. */
  recordFeatureRealign(key: string): Promise<CommandResult>;
  /** A check refused the line before it was offered: kept, with the round it costs. */
  recordFeatureParkedRefusal(input: {
    key: string;
    report: string;
    refusedBy?: string;
  }): Promise<CommandResult>;
  /** Whatever sent the line back is repaired and checked. */
  clearFeatureParkedRefusal(key: string): Promise<CommandResult>;
  /** `submitted` → `done`. */
  markFeatureDone(key: string, input?: { reference?: string | undefined }): Promise<CommandResult>;
  /** The tracker's feature-test skip label moved: honoured while the Feature waits, is open or is escalated. */
  setFeatureSkipFeatureTest(input: { key: string; skip: boolean }): Promise<CommandResult>;
  /** `open` or `submitted` → `escalated`, for a human. Consumes a pending edit. */
  escalateFeature(input: {
    key: string;
    report?: string;
    /** Where the line stopped, when the caller knows. */
    kind?: "assembly" | "submitted";
    /** What refused it, when the refusal came with a name. */
    refusedBy?: string;
  }): Promise<CommandResult>;
  /** `escalated` → `open`, a round later. The Feature's work is marked stale: its line may have gained commits while it waited. */
  resumeFeature(key: string): Promise<CommandResult>;
  /** An `open` Feature's work holds what its line gained since a resume (or was made after it): the stale mark goes. */
  markFeatureWorkspaceCurrent(key: string): Promise<CommandResult>;
  /** Anything but `done` → `cancelled`. */
  cancelFeature(key: string): Promise<CommandResult>;
  getFeature(key: string): Promise<FeatureGetResult>;
  listFeatures(): Promise<FeatureSummary[]>;
  /** The Feature that holds the Project: `open`, `submitted` or `escalated`. */
  activeFeatureOn(project: string): Promise<FeatureSummary | undefined>;
};

function cloneIntention(feature: FeatureAdmission): FeatureIntention {
  const intention: FeatureIntention = {
    key: feature.key,
    project: feature.project,
    fingerprint: feature.fingerprint,
    priority: feature.priority,
    intention: feature.intention,
    blocked_by: [...feature.blocked_by],
    merge_when_ready: feature.merge_when_ready,
  };
  if (feature.skip_feature_test === true) {
    intention.skip_feature_test = true;
  }
  if (feature.title !== undefined) {
    intention.title = feature.title;
  }
  if (feature.manager !== undefined) {
    intention.manager = feature.manager;
  }
  if (feature.external_id !== undefined) {
    intention.external_id = feature.external_id;
  }
  if (feature.source !== undefined) {
    intention.source = { ...feature.source };
  }
  return intention;
}

export function openFeatureCommands(options: {
  persist: PersistencePort;
  now: () => number;
}): FeatureCommands {
  const { persist, now } = options;

  const loadFeature = async (key: string): Promise<FeatureAggregate | undefined> => {
    const found: Aggregate | undefined = await persist.load(key);
    return found !== undefined && isFeatureAggregate(found) ? found : undefined;
  };

  const write = async (aggregate: FeatureAggregate): Promise<CommandResult> => {
    const saved = await persist.save(aggregate.intention.key, aggregate);
    return saved.ok ? { ok: true } : refused("persist-failed");
  };

  const summaries = async (): Promise<FeatureSummary[]> =>
    (await persist.listSummaries()).filter(isFeatureSummary);

  /** Load, check the state, change, write. */
  const transition = async (
    key: string,
    from: readonly FeatureState[],
    change: (aggregate: FeatureAggregate) => void,
  ): Promise<CommandResult> => {
    const found = await loadFeature(key);
    if (found === undefined) {
      return refused("not-found");
    }
    if (!from.includes(found.state)) {
      return refused("illegal-transition");
    }
    const next = structuredClone(found);
    change(next);
    return await write(next);
  };

  return {
    async admitFeature(feature) {
      const existing = await loadFeature(feature.key);
      if (existing === undefined) {
        return await write({
          kind: "feature",
          intention: cloneIntention(feature),
          state: "waiting",
          received_at: now(),
          tickets: [],
          resumes: 0,
        });
      }
      if (existing.state === "done") {
        return refused("too-late");
      }
      if (existing.state === "cancelled") {
        return refused("illegal-transition");
      }
      if (existing.state === "waiting") {
        if (existing.intention.fingerprint === feature.fingerprint) {
          return { ok: true };
        }
        const next = structuredClone(existing);
        next.intention = cloneIntention(feature);
        return await write(next);
      }
      if (
        feature.fingerprint === existing.intention.fingerprint ||
        feature.fingerprint === existing.pending_fingerprint
      ) {
        return { ok: true };
      }
      const next = structuredClone(existing);
      next.pending_fingerprint = feature.fingerprint;
      return await write(next);
    },

    async nextFeature(project) {
      const all = await summaries();
      if (all.some((s) => s.project === project && HOLDING.has(s.state))) {
        return undefined;
      }
      const waiting = all
        .filter((s) => s.project === project && s.state === "waiting")
        .sort((a, b) => b.priority - a.priority || a.received_at - b.received_at);
      for (const candidate of waiting) {
        const loaded = await loadFeature(candidate.key);
        if (loaded === undefined) {
          continue;
        }
        let unblocked = true;
        for (const blocker of loaded.intention.blocked_by) {
          if ((await loadFeature(blocker))?.state !== "done") {
            unblocked = false;
            break;
          }
        }
        if (unblocked) {
          return candidate;
        }
      }
      return undefined;
    },

    async openFeature(input) {
      const found = await loadFeature(input.key);
      if (found === undefined) {
        return refused("not-found");
      }
      if (found.state !== "waiting") {
        return refused("illegal-transition");
      }
      const all = await summaries();
      if (all.some((s) => s.project === found.intention.project && HOLDING.has(s.state))) {
        return refused("project-busy");
      }
      const next = structuredClone(found);
      next.state = "open";
      if (input.line !== undefined) {
        next.line = input.line;
      }
      next.tickets = [...input.tickets];
      return await write(next);
    },

    async markFeatureSubmitted(input) {
      return await transition(input.key, ["open"], (aggregate) => {
        aggregate.state = "submitted";
        // Rebuilt field by field so what was spent on the line is carried on
        // purpose: offered again, it is the same delivery with new content.
        const previous = aggregate.submission;
        aggregate.submission = {
          reference: input.reference,
          submitted_at: previous?.submitted_at ?? now(),
          ...(previous?.refusals === undefined ? {} : { refusals: previous.refusals }),
          ...(previous?.realigns === undefined ? {} : { realigns: previous.realigns }),
          ...(previous?.last_report === undefined ? {} : { last_report: previous.last_report }),
          ...(previous?.last_refused_by === undefined
            ? {}
            : { last_refused_by: previous.last_refused_by }),
        };
      });
    },

    async recordFeatureRefusal(input) {
      return await transition(input.key, ["submitted"], (aggregate) => {
        if (aggregate.submission === undefined) {
          return;
        }
        aggregate.submission = {
          ...aggregate.submission,
          refusals: (aggregate.submission.refusals ?? 0) + 1,
          last_report: input.report,
          ...(input.refusedBy === undefined ? {} : { last_refused_by: input.refusedBy }),
        };
        aggregate.state = "open";
        // A parked refusal from before the line was offered is stale the moment
        // a Submission has its own: two reports would leave the fix guessing.
        delete aggregate.parked_refusal;
      });
    },

    async recordFeatureRealign(key) {
      return await transition(key, ["submitted"], (aggregate) => {
        if (aggregate.submission === undefined) {
          return;
        }
        // What an earlier refusal said was repaired already; left in place it
        // would send the next round to repair it again.
        const { last_report: _report, last_refused_by: _by, ...kept } = aggregate.submission;
        aggregate.submission = { ...kept, realigns: (kept.realigns ?? 0) + 1 };
        aggregate.state = "open";
        delete aggregate.parked_refusal;
      });
    },

    async recordFeatureParkedRefusal(input) {
      return await transition(input.key, ["open"], (aggregate) => {
        aggregate.parked_refusal = {
          report: input.report,
          ...(input.refusedBy === undefined ? {} : { refused_by: input.refusedBy }),
        };
        aggregate.parked_refusals = (aggregate.parked_refusals ?? 0) + 1;
      });
    },

    async clearFeatureParkedRefusal(key) {
      const found = await loadFeature(key);
      if (found === undefined) {
        return refused("not-found");
      }
      if (found.parked_refusal === undefined) {
        return { ok: true };
      }
      const next = structuredClone(found);
      delete next.parked_refusal;
      return await write(next);
    },

    async markFeatureDone(key, input) {
      return await transition(key, ["submitted"], (aggregate) => {
        aggregate.state = "done";
        if (input?.reference !== undefined) {
          aggregate.integration_reference = input.reference;
        }
      });
    },

    async escalateFeature(input) {
      return await transition(input.key, ["open", "submitted"], (aggregate) => {
        aggregate.state = "escalated";
        const escalation: NonNullable<FeatureAggregate["escalation"]> = { at: now() };
        if (input.report !== undefined && input.report.trim().length > 0) {
          escalation.report = input.report;
        }
        if (input.kind !== undefined) {
          escalation.kind = input.kind;
        }
        if (input.refusedBy !== undefined && input.refusedBy.length > 0) {
          escalation.refused_by = input.refusedBy;
        }
        aggregate.escalation = escalation;
        delete aggregate.pending_fingerprint;
      });
    },

    async resumeFeature(key) {
      return await transition(key, ["escalated"], (aggregate) => {
        aggregate.state = "open";
        aggregate.resumes += 1;
        aggregate.workspace_stale = true;
        delete aggregate.escalation;
      });
    },

    async markFeatureWorkspaceCurrent(key) {
      return await transition(key, ["open"], (aggregate) => {
        delete aggregate.workspace_stale;
      });
    },

    async setFeatureSkipFeatureTest(input) {
      return await transition(input.key, ["waiting", "open", "escalated"], (aggregate) => {
        if (input.skip) {
          aggregate.intention.skip_feature_test = true;
        } else {
          delete aggregate.intention.skip_feature_test;
        }
      });
    },

    async cancelFeature(key) {
      const found = await loadFeature(key);
      if (found === undefined) {
        return refused("not-found");
      }
      if (found.state === "done") {
        return refused("point-of-no-return");
      }
      if (found.state === "cancelled") {
        return { ok: true };
      }
      const next = structuredClone(found);
      next.state = "cancelled";
      return await write(next);
    },

    async getFeature(key) {
      const found = await loadFeature(key);
      return found === undefined
        ? { ok: false, code: "not-found" }
        : { ok: true, aggregate: found };
    },

    async listFeatures() {
      return await summaries();
    },

    async activeFeatureOn(project) {
      return (await summaries()).find((s) => s.project === project && HOLDING.has(s.state));
    },
  };
}
