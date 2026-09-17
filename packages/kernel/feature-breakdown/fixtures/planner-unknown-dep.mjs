#!/usr/bin/env node
process.stdout.write(
  `${JSON.stringify({
    subtasks: [
      {
        id: "st-1",
        intention: "A",
        definition_of_done: "done A",
        depends_on: ["st-99"],
      },
    ],
  })}\n`,
);
