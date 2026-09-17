#!/usr/bin/env node
process.stdout.write(
  `${JSON.stringify({
    subtasks: [
      {
        id: "A",
        intention: "deliver the marker file",
        definition_of_done: "delivered.txt exists",
        depends_on: [],
      },
    ],
  })}\n`,
);
