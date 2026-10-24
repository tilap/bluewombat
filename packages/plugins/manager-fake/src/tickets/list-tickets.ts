import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FeatureRef, TicketEntry, TicketStandard } from "@bluewombat/manager-kit";
import { fingerprintOf } from "../adapter/normalize/fingerprint.js";

const MANAGER = "fake";
const DEFAULT_PRIORITY = 50;

/**
 * The Tickets a Feature carries, read from the newest file of the Source that
 * is about that Feature. A Ticket is a plain object under `tickets`:
 *
 *   { "id": "7", "intention": "…", "blocked_by": ["6"], "task_ready": false,
 *     "resume": true, "open": false, "priority": 70 }
 *
 * `task_ready` and `open` default to true, `resume`, `no_tests` and `e2e` to false. A Ticket's key is
 * `fake:<id>`, like a Feature's, so ids are unique across both.
 */
export function listTickets(source: string, feature: FeatureRef): TicketEntry[] {
  const payload = newestPayloadOf(source, feature.external_id);
  const raw = payload?.tickets;
  if (!Array.isArray(raw)) {
    return [];
  }
  const entries: TicketEntry[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const entry = entryOf(item as Record<string, unknown>, feature);
    if (entry !== undefined) {
      entries.push(entry);
    }
  }
  return entries;
}

function entryOf(raw: Record<string, unknown>, feature: FeatureRef): TicketEntry | undefined {
  const id = idOf(raw.id);
  if (id === undefined) {
    return undefined;
  }
  const title = textOf(raw.title);
  const intention = textOf(raw.intention) ?? title;
  if (intention === undefined) {
    return undefined;
  }
  const blocked = Array.isArray(raw.blocked_by)
    ? raw.blocked_by.map(idOf).filter((entry): entry is string => entry !== undefined)
    : [];
  const priority =
    typeof raw.priority === "number" && Number.isInteger(raw.priority)
      ? raw.priority
      : DEFAULT_PRIORITY;
  const ticket: TicketStandard = {
    key: `${MANAGER}:${id}`,
    manager: MANAGER,
    external_id: id,
    project: feature.project,
    ...(title === undefined ? {} : { title }),
    intention,
    priority,
    blocked_by: blocked.map((other) => `${MANAGER}:${other}`),
    fingerprint: "",
    normalized_at: new Date().toISOString(),
  };
  ticket.fingerprint = fingerprintOf(ticket as unknown as Record<string, unknown>);
  return {
    ticket,
    task_ready: raw.task_ready !== false,
    resume: raw.resume === true,
    no_tests: raw.no_tests === true,
    e2e: raw.e2e === true,
    open: raw.open !== false,
  };
}

function newestPayloadOf(source: string, id: string): Record<string, unknown> | undefined {
  let found: Record<string, unknown> | undefined;
  const names = readdirSync(source)
    .filter((name) => name.endsWith(".json"))
    .sort();
  for (const name of names) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(source, name), "utf8"));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        continue;
      }
      const payload = parsed as Record<string, unknown>;
      const kind = typeof payload.kind === "string" ? payload.kind.toLowerCase() : "create";
      if (idOf(payload.id) === id && (kind === "create" || kind === "update")) {
        found = payload;
      }
    } catch {
      // A file that is not JSON is the listener's to report, not this reader's.
    }
  }
  return found;
}

function idOf(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return undefined;
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
