#!/usr/bin/env node
const intention = process.env.PLANNER_INTENTION ?? "Add the CSV serializer";
process.stdout.write(
  `${JSON.stringify({
    subtasks: [
      {
        id: "st-1",
        intention,
        definition_of_done: "A unit test writes a CSV matching the fixture",
        depends_on: [],
      },
    ],
  })}\n`,
);
