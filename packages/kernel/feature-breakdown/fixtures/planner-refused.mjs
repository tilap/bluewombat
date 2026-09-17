#!/usr/bin/env node
process.stdout.write(
  `${JSON.stringify({
    outcome: "refused",
    code: "not-specifiable",
    reason: "The intention asks for two contradictory results.",
  })}\n`,
);
