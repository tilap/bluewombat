#!/usr/bin/env node
process.stdout.write(
  `${JSON.stringify({ verdict: "fail-retryable", report: "the line is not good yet" })}\n`,
);
