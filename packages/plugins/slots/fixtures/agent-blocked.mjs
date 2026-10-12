#!/usr/bin/env node
/** An agent that looked, found nothing it can act on, and says so. Changes nothing. */
process.stdout.write(
  `${JSON.stringify({
    type: "result",
    is_error: false,
    result: "I looked at the report.\nMASON_BLOCKED: the report is only a link, no log to read",
  })}\n`,
);
process.exit(0);
