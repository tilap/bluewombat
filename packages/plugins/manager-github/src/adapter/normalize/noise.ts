/**
 * What the tracker put on an issue body that the human did not write.
 * Pure: no clock, no request, no file.
 *
 * The body is the intention verbatim, and its fingerprint is what tells an
 * edit from an echo. Two things GitHub itself puts there would otherwise pass
 * for an edit: the comments an issue template leaves behind, and the boxes of
 * a task list — a human ticking one is the most ordinary gesture on the page,
 * and it is not a change of mind. Both leave; the words stay. Nothing here
 * reads the words: no criteria, no headings, no meaning.
 */

const HTML_COMMENT = /<!--[\s\S]*?-->/g;
/** A list item that opens with a box: the bullet and the words are kept, the box is not. */
const TASK_BOX = /^(\s*(?:[-*+]|\d+[.)])\s+)\[[ xX]\](?:\s+|$)/;

export function stripTrackerNoise(body: string): string {
  const lines = body
    .replace(HTML_COMMENT, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(TASK_BOX, "$1").trimEnd())
    // A box with nothing after it was a line the human never filled in.
    .filter((line) => !/^\s*(?:[-*+]|\d+[.)])$/.test(line));
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
