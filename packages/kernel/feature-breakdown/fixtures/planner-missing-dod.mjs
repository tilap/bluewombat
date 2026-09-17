#!/usr/bin/env node
process.stdout.write(
  `${JSON.stringify({
    subtasks: [
      {
        id: "st-1",
        intention: "A",
        depends_on: [],
      },
    ],
  })}\n`,
);
