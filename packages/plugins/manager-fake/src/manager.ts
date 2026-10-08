import type { AdaptResult, ListenResult, ManagerPort, ReportInput } from "@bluewombat/manager-kit";
import { fingerprintOf } from "./adapter/normalize/fingerprint.js";
import { runAdapter } from "./adapter/run/run-adapter.js";
import { runEmitter } from "./emitter/run/run-emitter.js";
import { runListener } from "./listener/run/run-listener.js";

const silent = (): void => { };
const MANAGER = "fake";
const UNKNOWN_PROJECT = "unknown";
const DEFAULT_PRIORITY = 50;
const DEFAULT_MAX_EVENTS = 10_000;
const DEFAULT_MAX_RAW_BYTES = 65_536;
const MAX_REPORT_CHARS = 8_000;

export type FakeManagerOptions = {
  /** Directory holding one JSON file per raw intention. Must exist. */
  source: string;
  /** Directory the Thread `<slug>.ndjson` files are appended to. */
  emitterTarget: string;
  durationMs: number;
  interruptFlag: { interrupted: boolean };
  defaultPriority?: number;
};

/**
 * Directory Source + directory Thread. The wiring that needs no account.
 */
export function createFakeManager(options: FakeManagerOptions): ManagerPort {
  const defaultPriority = options.defaultPriority ?? DEFAULT_PRIORITY;
  return {
    async listen(input): Promise<ListenResult> {
      const deliveries: ListenResult["deliveries"] = [];
      const listenerInvocation: Parameters<typeof runListener>[0]["invocation"] = {
        manager: MANAGER,
        source: options.source,
        follow: false,
        maxEvents: DEFAULT_MAX_EVENTS,
        durationMs: options.durationMs,
      };
      if (input.since !== undefined) {
        listenerInvocation.since = input.since;
      }
      const listened = await runListener({
        invocation: listenerInvocation,
        write: (line) => {
          if (
            line.event === "intention" &&
            typeof line.cursor === "string" &&
            isObject(line.payload)
          ) {
            deliveries.push({ cursor: line.cursor, payload: line.payload });
          }
        },
        interruptFlag: options.interruptFlag,
      });
      return { outcome: listened.outcome, deliveries };
    },

    async adapt(payload): Promise<AdaptResult> {
      const adapted = await runAdapter({
        invocation: {
          manager: MANAGER,
          defaultPriority,
          maxRawBytes: DEFAULT_MAX_RAW_BYTES,
        },
        raw: JSON.stringify(payload),
        write: silent,
        interruptFlag: options.interruptFlag,
      });
      if (adapted.outcome === "invalid" && adapted.invalid !== undefined) {
        return {
          outcome: "invalid",
          invalid: adapted.invalid,
          key: keyFromRaw(payload),
          project: projectFromRaw(payload),
          fingerprint: fingerprintOf(payload),
        };
      }
      if (adapted.outcome === "unavailable" || adapted.outcome === "interrupted") {
        return { outcome: adapted.outcome };
      }
      if (adapted.outcome !== "converted" || adapted.feature === undefined) {
        return { outcome: "unavailable" };
      }
      return { outcome: "converted", feature: adapted.feature };
    },

    async report(input: ReportInput): Promise<boolean> {
      const result = runEmitter({
        invocation: {
          target: options.emitterTarget,
          event: input.event,
          key: input.key,
          project: input.project,
          at: new Date().toISOString(),
          fields: input.fields,
          ...(input.eventId === undefined ? {} : { eventId: input.eventId }),
          maxReportChars: MAX_REPORT_CHARS,
          dryRun: false,
        },
        write: silent,
      });
      // Same as GitHub: a Thread that already carries this eventId has said it.
      return result.outcome === "reported" || result.outcome === "duplicate";
    },
  };
}

function keyFromRaw(payload: Record<string, unknown>): string {
  const id = rawId(payload);
  return id === undefined ? `${MANAGER}:unconvertible` : `${MANAGER}:${id}`;
}

function rawId(payload: Record<string, unknown>): string | undefined {
  const value = payload.id;
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function projectFromRaw(payload: Record<string, unknown>): string {
  const value = payload.project;
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return UNKNOWN_PROJECT;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
