import { EVENT_NAMES, type EventName } from "@bluewombat/manager-kit";

/** The label each Event lands as on an issue. */
export type StateLabels = Readonly<Record<EventName, string>>;

export type StateLabelsResult =
  | { ok: true; labels: StateLabels | undefined }
  | { ok: false; reason: string };

/**
 * The label of every Event, from the `stateLabels` option.
 *
 * Absent, the Events leave no label. Present, it names every Event: an Event
 * with no label would leave the previous one on the issue, and two Events
 * cannot share one, or the issue could not tell them apart.
 */
export function resolveStateLabels(named: Record<string, string> | undefined): StateLabelsResult {
  if (named === undefined) {
    return { ok: true, labels: undefined };
  }
  const known = new Set<string>(EVENT_NAMES);
  for (const key of Object.keys(named)) {
    if (!known.has(key)) {
      return {
        ok: false,
        reason: `"stateLabels" names "${key}", which is not an event (${EVENT_NAMES.join(", ")}).`,
      };
    }
  }
  const missing = EVENT_NAMES.filter((event) => named[event] === undefined);
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `"stateLabels" must name every event; missing: ${missing.join(", ")}.`,
    };
  }
  const labels = Object.fromEntries(
    EVENT_NAMES.map((event) => [event, named[event] as string]),
  ) as Record<EventName, string>;
  const owners = new Map<string, EventName>();
  for (const event of EVENT_NAMES) {
    const key = labels[event].toLowerCase();
    const other = owners.get(key);
    if (other !== undefined) {
      return {
        ok: false,
        reason: `"stateLabels" gives "${labels[event]}" to both ${other} and ${event}.`,
      };
    }
    owners.set(key, event);
  }
  return { ok: true, labels };
}

/** The label of this Event, if it is one the state labels cover. */
export function stateLabelOf(labels: StateLabels, event: string): string | undefined {
  return (EVENT_NAMES as readonly string[]).includes(event)
    ? labels[event as EventName]
    : undefined;
}

/** Whether this label is one of the state labels, whatever the case. */
export function isStateLabel(labels: StateLabels, name: string): boolean {
  const wanted = name.toLowerCase();
  return EVENT_NAMES.some((event) => labels[event].toLowerCase() === wanted);
}
