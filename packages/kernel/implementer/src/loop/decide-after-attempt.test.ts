import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideAfterAttempt } from "./decide-after-attempt.js";

describe("decideAfterAttempt", () => {
  it("finishes validated when the Attempt validated", () => {
    assert.deepEqual(
      decideAfterAttempt({
        ended: "validated",
        attemptsStarted: 1,
        maxAttempts: 3,
      }),
      { action: "finish", outcome: "validated" },
    );
  });

  it("escalates on fail-blocking without consuming remaining Attempts", () => {
    assert.deepEqual(
      decideAfterAttempt({
        ended: "fail-blocking",
        attemptsStarted: 1,
        maxAttempts: 5,
      }),
      { action: "finish", outcome: "escalated" },
    );
  });

  it("finishes interrupted on stop signal", () => {
    assert.deepEqual(
      decideAfterAttempt({
        ended: "interrupted",
        attemptsStarted: 2,
        maxAttempts: 5,
      }),
      { action: "finish", outcome: "interrupted" },
    );
  });

  it("retries on fail-retryable when Attempts and task time remain", () => {
    assert.deepEqual(
      decideAfterAttempt({
        ended: "fail-retryable",
        attemptsStarted: 1,
        maxAttempts: 3,
      }),
      { action: "retry" },
    );
  });

  it("escalates when max Attempts are exhausted on retryable failure", () => {
    assert.deepEqual(
      decideAfterAttempt({
        ended: "fail-retryable",
        attemptsStarted: 3,
        maxAttempts: 3,
      }),
      { action: "finish", outcome: "escalated" },
    );
  });
});
