#!/usr/bin/env node
// A refusal whose report is longer than a small output cap: the verdict line
// must still be read whole.
const report = `${"x".repeat(20_000)}\nTypeError: Object.groupBy is not a function`;
process.stdout.write(`${JSON.stringify({ verdict: "fail-retryable", report })}\n`);
