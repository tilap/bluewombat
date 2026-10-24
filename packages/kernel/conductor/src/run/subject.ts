const SUBJECT_MAX = 72;

/**
 * A fold's subject out of prose. Text written the way a commit is — a headline,
 * a blank line, the rest — gives its headline. Otherwise the first sentence,
 * cut at a word when even that runs past what one line of history shows. A
 * subject is not markdown, so the backticks prose uses for names come off; and
 * it ends on a word, not on an ellipsis — the whole text follows in the body
 * for whoever wants it.
 */
export function subjectOf(text: string): string {
  const trimmed = text.trim();
  const headline = /^([^\n]+)\n\s*\n/.exec(trimmed)?.[1];
  const oneLine = (headline ?? trimmed).replace(/\s+/g, " ");
  // A sentence ends where the next one starts with a capital, or where the
  // text ends: "e.g. foo" and "src/index.js" are not sentence ends.
  const sentence = /^(.*?[.!?])(?:\s+(?=[A-Z\p{Lu}])|$)/u.exec(oneLine)?.[1] ?? oneLine;
  const candidate = sentence.replace(/`/g, "").replace(/[.:;,\s]+$/, "");
  if (candidate.length <= SUBJECT_MAX) {
    return candidate;
  }
  const cut = candidate.slice(0, SUBJECT_MAX);
  const atWord = cut.lastIndexOf(" ");
  return (atWord > SUBJECT_MAX / 2 ? cut.slice(0, atWord) : cut).replace(/[.:;,\s]+$/, "");
}

/** Subject line, then the whole text when the subject did not carry it all. */
export function foldMessageOf(text: string): string {
  const subject = subjectOf(text);
  const whole = text.trim();
  return subject === whole || subject === whole.replace(/[.\s]+$/, "")
    ? subject
    : `${subject}\n\n${whole}`;
}
