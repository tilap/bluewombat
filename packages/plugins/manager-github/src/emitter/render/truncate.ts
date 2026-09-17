export const TRUNCATION_MARKER = " […truncated]";

export type TruncateResult = { text: string; truncated: boolean };

/** Cut long free text, and say so: a silent cut makes a human trust a
 *  truncated diagnosis. */
export function truncateText(text: string, maxChars: number): TruncateResult {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  return { text: `${text.slice(0, maxChars)}${TRUNCATION_MARKER}`, truncated: true };
}
