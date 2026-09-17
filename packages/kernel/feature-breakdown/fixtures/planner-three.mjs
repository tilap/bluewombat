#!/usr/bin/env node
process.stdout.write(
  `${JSON.stringify({
    subtasks: [
      { id: "st-1", intention: "A", definition_of_done: "done A", depends_on: [] },
      { id: "st-2", intention: "B", definition_of_done: "done B", depends_on: ["st-1"] },
      { id: "st-3", intention: "C", definition_of_done: "done C", depends_on: ["st-2"] },
    ],
  })}\n`,
);
