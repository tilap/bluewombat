#!/usr/bin/env node
/** Builder that returns fail-retryable JSON. */
process.stdout.write(
  `${JSON.stringify({ outcome: "fail-retryable", report: "builder could not finish" })}\n`,
);
process.exit(1);
