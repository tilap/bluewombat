import type { Intent, Invalid } from "../types.js";
import { hasLabel } from "./labels.js";

/** What a repository can say about an issue, in this Block's five words. */
export type Kind = "create" | "update" | "ready" | "cancel" | "delete";

const ACTION_TO_KIND: Record<string, Kind> = {
  opened: "create",
  reopened: "create",
  edited: "update",
  labeled: "update",
  unlabeled: "update",
  assigned: "update",
  unassigned: "update",
  milestoned: "update",
  demilestoned: "update",
  pinned: "update",
  unpinned: "update",
  locked: "update",
  unlocked: "update",
  typed: "update",
  untyped: "update",
  closed: "cancel",
  deleted: "delete",
  transferred: "delete",
};

const KIND_TO_INTENT: Record<Kind, Intent> = {
  create: "upsert",
  update: "upsert",
  ready: "ready",
  cancel: "cancel",
  delete: "cancel",
};

export type IntentInput = {
  action: string | undefined;
  state: string | undefined;
  labels: string[];
  readyLabel: string;
};

export type IntentResult = { ok: true; intent: Intent } | { ok: false; invalid: Invalid };

/**
 * Collapse what happened into one of three intents.
 *
 * With an action, the repository said what changed. Without one — a snapshot a
 * subscription listed — only the state is known: open means the intention
 * itself, closed means drop it. `ready` needs the edge, not the state: it is the
 * moment the label arrived, and a snapshot cannot tell that from a label that
 * has been there for a week.
 */
export function readIntent(input: IntentInput): IntentResult {
  if (input.action === undefined) {
    return { ok: true, intent: input.state === "closed" ? "cancel" : "upsert" };
  }

  const kind = ACTION_TO_KIND[input.action];
  if (kind === undefined) {
    return {
      ok: false,
      invalid: {
        code: "unknown-action",
        reason: `Action "${input.action}" is not one this Block reads.`,
      },
    };
  }
  if (input.action === "labeled" && hasLabel(input.labels, input.readyLabel)) {
    return { ok: true, intent: KIND_TO_INTENT.ready };
  }
  return { ok: true, intent: KIND_TO_INTENT[kind] };
}
