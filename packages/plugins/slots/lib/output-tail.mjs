// The end of a command's output, for a Gate's report: what a person or an agent needs to read
// to see why a check is red.
//
// Test runners and CLIs redraw a progress line (a spinner, "[✓] Pulling schema...") thousands of
// times. Kept as bytes, those redraws push the real error out of the tail the report is cut from,
// and the report says nothing but the spinner. So the output is cleaned line by line as it
// arrives, before anything is dropped for size: escape codes removed, a line redrawn with "\r"
// reduced to its last state, spinner and progress lines dropped.

// CSI sequences (colors, erase line, cursor moves) and OSC sequences (titles, links).
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const ESCAPES = new RegExp(
  `${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`,
  "g",
);
// A braille glyph is a spinner frame; "[✓] …..." is the line a spinner settles on.
const SPINNER_FRAME = /[⠀-⣿]/;
const SPINNER_DONE = /\[[✓✔]\].*\.\.\.\s*$/;

/** One line, cleaned; null when it is only progress noise. */
export function cleanLine(/** @type {string} */ raw) {
  const redrawn = raw.split("\r").filter((part) => part.trim().length > 0);
  const last = (redrawn.length > 0 ? redrawn[redrawn.length - 1] : "") ?? "";
  const line = last.replace(ESCAPES, "").trimEnd();
  if (SPINNER_FRAME.test(line) || SPINNER_DONE.test(line)) {
    return null;
  }
  return line;
}

/**
 * @param {number} maxChars what `text()` returns at most; older lines are dropped first.
 */
export function createOutputTail(maxChars) {
  let kept = "";
  /** @type {Map<string, string>} */
  const partial = new Map();

  const add = (/** @type {string} */ raw) => {
    const line = cleanLine(raw);
    if (line === null) {
      return;
    }
    kept += `${line}\n`;
    if (kept.length > maxChars * 2) {
      kept = kept.slice(kept.length - maxChars);
    }
  };

  return {
    /** Feed a chunk of one stream; each stream keeps its own unfinished line. */
    push(/** @type {string} */ stream, /** @type {Buffer | string} */ chunk) {
      const lines = ((partial.get(stream) ?? "") + chunk.toString()).split("\n");
      partial.set(stream, lines.pop() ?? "");
      lines.forEach(add);
    },
    /** The cleaned end of the output, cut on a line boundary. */
    text() {
      for (const rest of partial.values()) {
        if (rest.length > 0) {
          add(rest);
        }
      }
      partial.clear();
      const cut = kept.length > maxChars ? kept.slice(kept.length - maxChars) : kept;
      return (kept.length > maxChars ? cut.slice(cut.indexOf("\n") + 1) : cut).trim();
    },
  };
}
