#!/usr/bin/env node
process.stdout.write(
  `${JSON.stringify({
    subtasks: [
      {
        id: "st-1",
        intention: "Add the CSV serializer",
        definition_of_done: "A unit test writes a CSV matching the fixture",
        depends_on: [],
      },
      {
        id: "st-2",
        intention: "Wire the export button",
        definition_of_done: "Clicking Export downloads the CSV",
        depends_on: ["st-1"],
      },
    ],
  })}\n`,
);
