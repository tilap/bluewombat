#!/usr/bin/env node
const args = process.argv.slice(2);
const attemptIdx = args.indexOf("--attempt");
const attempt = attemptIdx >= 0 ? Number(args[attemptIdx + 1]) : 1;
if (attempt === 1) {
  process.stdout.write(`${JSON.stringify({ verdict: "fail-retryable", report: "lint failed" })}\n`);
  process.exit(0);
}
process.stdout.write(`${JSON.stringify({ verdict: "pass" })}\n`);
