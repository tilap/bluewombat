#!/usr/bin/env node
process.stdout.write(
  `${JSON.stringify({ verdict: "fail-blocking", report: "assembly gate blocked" })}\n`,
);
