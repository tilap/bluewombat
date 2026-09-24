#!/usr/bin/env node
/** A reviewer that accepts the assembled feature. */
process.stdout.write(
  `${JSON.stringify({ type: "result", is_error: false, result: "MASON_VERDICT: VALIDATED" })}\n`,
);
process.exit(0);
