#!/usr/bin/env node
/** Builder that returns fail-blocking JSON. */
process.stdout.write(
  `${JSON.stringify({ outcome: "fail-blocking", report: "builder refused" })}\n`,
);
process.exit(1);
