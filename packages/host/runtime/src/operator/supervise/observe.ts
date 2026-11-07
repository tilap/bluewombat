import { createHash } from "node:crypto";

export type Item = {
  key: string;
  scope: "ticket" | "feature";
  state: string;
  escalation?: { report?: string; refusedBy?: string; at?: number };
};

/** What the supervisor can see of a run without asking anyone. */
export type Snapshot = {
  now: number;
  items: Item[];
  /** The process that holds the ledger, when it is alive. */
  workerPid?: number;
  /** When the journal last grew. */
  journalAt?: number;
  freeBytes?: number;
  /** The supervisor is able to start a worker, so a missing one is its to fix. */
  canStartWorker: boolean;
};

export type Thresholds = { stallAfterMs: number; diskMinBytes: number; settleMs: number };

export type Finding = {
  kind: "escalated" | "stalled" | "worker-down" | "disk-low";
  /** What the memory is keyed by: one per thing that can go wrong in one place. */
  subject: string;
  /** Changes when the thing that went wrong changes. */
  fingerprint: string;
  key?: string;
  scope?: "ticket" | "feature";
  detail: string;
};

const ACTIVE = new Set(["running", "integrating", "submitted", "merging", "open"]);
const TERMINAL = new Set(["done", "cancelled", "invalid"]);

/**
 * What is wrong, from what can be seen. Pure: no ledger, no clock, no disk.
 *
 * Judging is not done here. A finding says that something needs looking at,
 * and carries enough to tell it from the same thing seen again.
 */
export function observe(snapshot: Snapshot, limits: Thresholds): Finding[] {
  const found: Finding[] = [];
  if (snapshot.workerPid === undefined && snapshot.canStartWorker) {
    found.push({
      kind: "worker-down",
      subject: "worker",
      fingerprint: "worker-down",
      detail: "No process holds the ledger.",
    });
  }
  const active = snapshot.items.filter((item) => ACTIVE.has(item.state));
  if (
    snapshot.workerPid !== undefined &&
    snapshot.journalAt !== undefined &&
    active.length > 0 &&
    snapshot.now - snapshot.journalAt > limits.stallAfterMs
  ) {
    const minutes = Math.round((snapshot.now - snapshot.journalAt) / 60_000);
    const oldest = active[0];
    found.push({
      kind: "stalled",
      subject: `stalled:${oldest?.key ?? "?"}`,
      fingerprint: `stalled:${active.map((item) => `${item.key}=${item.state}`).join(",")}`,
      ...(oldest === undefined ? {} : { key: oldest.key, scope: oldest.scope }),
      detail: `The journal has been silent for ${minutes} min with ${active.length} active: ${active
        .map((item) => `${item.key} (${item.state})`)
        .join(", ")}.`,
    });
  }
  if (snapshot.freeBytes !== undefined && snapshot.freeBytes < limits.diskMinBytes) {
    found.push({
      kind: "disk-low",
      subject: "disk",
      fingerprint: "disk-low",
      detail: `${(snapshot.freeBytes / 1024 ** 3).toFixed(1)} GiB free, under ${(limits.diskMinBytes / 1024 ** 3).toFixed(1)} GiB.`,
    });
  }
  for (const item of snapshot.items) {
    if (item.state !== "escalated" || youngerThanSettle(item, snapshot.now, limits.settleMs)) {
      continue;
    }
    const report = item.escalation?.report ?? "";
    found.push({
      kind: "escalated",
      subject: `escalated:${item.key}`,
      fingerprint: `escalated:${item.key}:${hash(`${report}|${item.escalation?.at ?? ""}`)}`,
      key: item.key,
      scope: item.scope,
      detail: report.split("\n")[0]?.slice(0, 200) ?? "",
    });
  }
  return found;
}

/** Keys that reached an end: whatever the supervisor remembered of them is spent. */
export function finished(items: Item[]): string[] {
  return items.filter((item) => TERMINAL.has(item.state)).map((item) => item.key);
}

function youngerThanSettle(item: Item, now: number, settleMs: number): boolean {
  const at = item.escalation?.at;
  // The ledger's clock is not promised to be epoch milliseconds: only a value that looks like one counts.
  return settleMs > 0 && at !== undefined && at > 1e12 && now - at < settleMs;
}

function hash(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 12);
}
