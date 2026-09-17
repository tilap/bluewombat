#!/usr/bin/env node
process.stdout.write(`${JSON.stringify({ verdict: "fail-retryable", report: "lint failed" })}\n`);
