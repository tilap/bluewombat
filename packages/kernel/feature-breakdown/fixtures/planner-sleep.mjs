#!/usr/bin/env node
const ms = Number(process.argv[2] ?? "60000");
await new Promise((resolve) => setTimeout(resolve, ms));
process.stdout.write(
  `${JSON.stringify({
    subtasks: [{ id: "st-1", intention: "A", definition_of_done: "d", depends_on: [] }],
  })}\n`,
);
