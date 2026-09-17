#!/usr/bin/env node
// Returns the fields a notification-shaped raw intention leaves out.
process.stdout.write(
  `${JSON.stringify({
    project: "fetched-project",
    intention: "fetched intention",
    priority: "high",
  })}\n`,
);
