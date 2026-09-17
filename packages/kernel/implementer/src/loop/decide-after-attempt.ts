import type { AttemptEnded, RunOutcome } from "../types.js";

export type LoopInput = {
  ended: AttemptEnded;
  /** Attempts started so far, including the one that just ended. */
  attemptsStarted: number;
  maxAttempts: number;
};

export type LoopDecision =
  | { action: "finish"; outcome: Exclude<RunOutcome, "invalid-invocation"> }
  | { action: "retry" };

/**
 * Pure loop rule: next action from the Attempt verdict and the count.
 *
 * No clock enters here any more. Every child of an Attempt carries its own
 * ceiling, so a slow one ends its Attempt as any other failure does, and the
 * budget of a whole Task is what the Project wrote: `maxAttempts` times the
 * producer and its Gates.
 */
export function decideAfterAttempt(input: LoopInput): LoopDecision {
  const { ended, attemptsStarted, maxAttempts } = input;

  if (ended === "validated") {
    return { action: "finish", outcome: "validated" };
  }
  if (ended === "fail-blocking") {
    return { action: "finish", outcome: "escalated" };
  }
  if (ended === "interrupted") {
    return { action: "finish", outcome: "interrupted" };
  }

  // fail-retryable
  if (attemptsStarted >= maxAttempts) {
    return { action: "finish", outcome: "escalated" };
  }
  return { action: "retry" };
}
