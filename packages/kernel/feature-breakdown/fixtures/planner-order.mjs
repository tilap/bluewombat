#!/usr/bin/env node
const swapped = process.env.PLANNER_SWAP_ORDER === "1";
const a = {
  id: "st-1",
  intention: "Add the CSV serializer",
  definition_of_done: "A unit test writes a CSV matching the fixture",
  depends_on: [],
};
const b = {
  id: "st-2",
  intention: "Wire the export button",
  definition_of_done: "Clicking Export downloads the CSV",
  depends_on: ["st-1"],
};
process.stdout.write(`${JSON.stringify({ subtasks: swapped ? [b, a] : [a, b] })}\n`);
