#!/usr/bin/env node
import { emitMessage, MESSAGE_FLAGS, ownArgv, take } from "@bluewombat/slot-kit";

// The feature's commit in the Conventional Commits shape, from the issue's
// title and body and with no agent: `<type>: <title>`, the body as written.
//
// The type is read off the title's first word — a Project that wants a
// judgement rather than a rule points `authority.describe` at
// `messages/git-producer.mjs` with an agent after `--`.
//
//   --scope NAME    put a scope on the subject: `feat(api): …`
//   --type NAME     one type for everything, instead of guessing it

const SUBJECT_MAX = 72;
/** @type {[RegExp, string][]} */
const TYPES = [
  [/^(fix|repair|correct|resolve)\b/i, "fix"],
  [/^(document|describe|write (the )?(readme|docs))\b/i, "docs"],
  [/^(test|cover)\b/i, "test"],
  [/^(refactor|rename|move|extract|simplify|clean)\b/i, "refactor"],
  [/^(bump|upgrade|update (the )?dependenc|configure|set up|setup)\b/i, "chore"],
];

const own = ownArgv(process.argv, MESSAGE_FLAGS);
const scope = take(own, "--scope");
const forcedType = take(own, "--type");
const title = (take(process.argv, "--title") ?? "").trim();
const intention = (take(process.argv, "--intention") ?? "").trim();
if (title.length === 0) {
  process.stderr.write("conventional: no --title.\n");
  process.exit(1);
}

const sentence = firstSentence(title);
const type = forcedType ?? TYPES.find(([pattern]) => pattern.test(sentence))?.[1] ?? "feat";
const head = `${type}${scope === undefined ? "" : `(${scope})`}: `;
const subject = `${head}${fit(lowerFirst(sentence), SUBJECT_MAX - head.length)}`;
if (intention.length === 0) {
  emitMessage(subject);
} else {
  emitMessage(subject, intention);
}

/** @param {string} text */
function firstSentence(text) {
  const oneLine = text.replace(/\s+/g, " ").trim();
  const match = /^(.*?[.!?])(?:\s+(?=[A-Z\p{Lu}])|$)/u.exec(oneLine);
  return (match?.[1] ?? oneLine).replace(/[.\s]+$/, "");
}

/** @param {string} text */
function lowerFirst(text) {
  // A word that is a name or a symbol keeps its case: `Add \`slugify\``, `README`.
  return /^[A-Z][a-z]/.test(text) ? `${text.slice(0, 1).toLowerCase()}${text.slice(1)}` : text;
}

/**
 * @param {string} text
 * @param {number} max
 */
function fit(text, max) {
  if (text.length <= max) {
    return text;
  }
  const cut = text.slice(0, max - 1);
  const atWord = cut.lastIndexOf(" ");
  return `${(atWord > max / 2 ? cut.slice(0, atWord) : cut).trimEnd()}…`;
}
