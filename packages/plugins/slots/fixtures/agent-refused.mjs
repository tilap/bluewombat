#!/usr/bin/env node
process.stdout.write(
  `${JSON.stringify({ type: "result", is_error: true, result: "I cannot do this." })}\n`,
);
process.exit(0);
