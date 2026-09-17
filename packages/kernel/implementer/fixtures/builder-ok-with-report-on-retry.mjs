#!/usr/bin/env node
/**
 * Succeeds on Attempt 1.
 * On later Attempts, requires --report and echoes whether it received it.
 */
const args = process.argv.slice(2);
const attemptIdx = args.indexOf("--attempt");
const attempt = attemptIdx >= 0 ? Number(args[attemptIdx + 1]) : 1;
const reportIdx = args.indexOf("--report");
const report = reportIdx >= 0 ? args[reportIdx + 1] : undefined;

if (attempt === 1) {
  process.exit(0);
}
if (report === undefined) {
  process.stdout.write(
    `${JSON.stringify({ outcome: "fail-blocking", report: "missing --report on retry" })}\n`,
  );
  process.exit(1);
}
process.stdout.write(`${JSON.stringify({ received_report: report })}\n`);
process.exit(0);
