/**
 * The one line a slot puts on stdout.
 *
 * stdout is the contract channel and carries nothing else: whatever a slot has
 * to say to a watching operator goes to stderr. Each role answers a different
 * shape, so each has its own function rather than one that takes a kind.
 */

/** A Gate's answer on the work in front of it. */
export type Verdict = "pass" | "fail-retryable" | "fail-blocking";

/** A Builder's answer when its pass did not produce work. */
export type Failure = Exclude<Verdict, "pass">;

export type Write = (line: string) => void;

const toStdout: Write = (line) => {
  process.stdout.write(line);
};

/** A Gate's verdict, with the report the next Attempt is given. */
export function emitVerdict(verdict: Verdict, report = "", write: Write = toStdout): void {
  write(`${JSON.stringify({ verdict, report })}\n`);
}

/** A Builder's failure. A pass says nothing: the workspace is the answer. */
export function emitFailure(outcome: Failure, report: string, write: Write = toStdout): void {
  write(`${JSON.stringify({ outcome, report })}\n`);
}

/** A Plan on stdout, and nothing else on it. */
export function emitPlan(subtasks: unknown, write: Write = toStdout): void {
  write(`${JSON.stringify({ subtasks })}\n`);
}

/**
 * Where the work now is, for the Authority to read.
 *
 * The reference is opaque above this line: a branch name, a directory, a URL —
 * whatever the Publisher put in front of the judge, named the way that judge
 * asks for it.
 */
export function emitPublication(ref: string, write: Write = toStdout): void {
  write(`${JSON.stringify({ ref })}\n`);
}

/**
 * The work could not be placed where the Authority reads.
 *
 * A refusal, not a crash: the Submission does not happen and the reason travels
 * back. A Publisher that could not run at all exits non-zero and says why on
 * stderr instead.
 */
export function emitPublishRefusal(reason: string, write: Write = toStdout): void {
  write(`${JSON.stringify({ outcome: "refused", reason })}\n`);
}

/**
 * What a commit should say: a subject line, and the body under it when there
 * is one. Host writes the subject as the first line and the body after a
 * blank one; how a Project words either is the slot's, not Host's.
 */
export function emitMessage(subject: string, body?: string, write: Write = toStdout): void {
  write(`${JSON.stringify(body === undefined ? { subject } : { subject, body })}\n`);
}

/**
 * The work line copy now holds what the Authority holds.
 *
 * Nothing to bring back is a success, not a special case: a Refresher that
 * found the copy already up to date answers the same way.
 */
export function emitRefreshed(write: Write = toStdout): void {
  write(`${JSON.stringify({ ok: true })}\n`);
}

/**
 * The copy could not be brought up to date.
 *
 * Work started on a copy that is behind is built on a version that no longer
 * exists, so this refusal stops the pass rather than letting it run.
 */
export function emitRefreshRefusal(reason: string, write: Write = toStdout): void {
  write(`${JSON.stringify({ outcome: "refused", reason })}\n`);
}

/**
 * The FeatureStandard cannot be split. This is a verdict on the intention, not
 * a failure of the slot: a slot that could not answer must exit non-zero and
 * say why on stderr, so the Breakdown is retried rather than the feature buried.
 */
export function emitRefusal(reason: string, write: Write = toStdout): void {
  write(`${JSON.stringify({ outcome: "refused", code: "not-specifiable", reason })}\n`);
}
