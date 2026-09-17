#!/usr/bin/env node
// Recorded from a real `claude -p --output-format json` run: `subtype` says
// success while `is_error` says otherwise, which is why the outcome is read
// from `is_error`.
process.stdout.write(
  `${JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: true,
    terminal_reason: "api_error",
    result: "Failed to authenticate: OAuth session expired and could not be refreshed",
  })}\n`,
);
process.exit(1);
