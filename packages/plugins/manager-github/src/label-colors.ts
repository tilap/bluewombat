import { EVENT_NAMES } from "@bluewombat/manager-kit";

/**
 * What `labelColors` can colour. Keys name what a label is for, never the label itself, so
 * renaming a label (`stateLabels`, `resumeLabel`, ...) does not lose its colour.
 *
 * One key per label, none for a group: `feature-ready`, `ticket-ready` and `merge-when-ready`
 * for the three ready labels, `resume` for the resume label, `project` for the
 * `project:<name>` label, and `state-<event>` for the label of each Event. When the Feature and
 * the Ticket ready labels are one label (the same name), `feature-ready` colours it.
 */
export const LABEL_COLOR_KEYS = [
  "feature-ready",
  "ticket-ready",
  "merge-when-ready",
  "resume",
  "project",
  ...EVENT_NAMES.map((event) => `state-${event}` as const),
] as const;
export type LabelColorKey = (typeof LABEL_COLOR_KEYS)[number];

/** The colours the config chose, by what the label is for, six lowercase hex digits each. */
export type LabelColors = Readonly<Partial<Record<LabelColorKey, string>>>;

export type LabelColorsResult =
  | { ok: true; colors: LabelColors | undefined }
  | { ok: false; reason: string };

const HEX = /^#?([0-9a-fA-F]{6})$/;

/** The colours from the `labelColors` option. A colour is six hex digits, with or without `#`. */
export function resolveLabelColors(named: Record<string, string> | undefined): LabelColorsResult {
  if (named === undefined) {
    return { ok: true, colors: undefined };
  }
  const known = new Set<string>(LABEL_COLOR_KEYS);
  const colors: Partial<Record<LabelColorKey, string>> = {};
  for (const [key, value] of Object.entries(named)) {
    if (!known.has(key)) {
      return {
        ok: false,
        reason: `"labelColors" names "${key}", which is not something a label is for (${LABEL_COLOR_KEYS.join(", ")}).`,
      };
    }
    const match = HEX.exec(value.trim());
    if (match?.[1] === undefined) {
      return {
        ok: false,
        reason: `"labelColors.${key}" must be six hex digits, like "1d76db"; got "${value}".`,
      };
    }
    colors[key as LabelColorKey] = match[1].toLowerCase();
  }
  return { ok: true, colors };
}
