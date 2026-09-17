#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";

const log = process.env.PLANNER_SPAWNED_LOG;
if (log) {
  appendFileSync(log, "spawned\n");
}
const argsLog = process.env.PLANNER_ARGS_LOG;
if (argsLog) {
  writeFileSync(argsLog, JSON.stringify(process.argv.slice(2)));
}
process.stdout.write(
  `${JSON.stringify({
    subtasks: [
      {
        id: "st-1",
        intention: "Add the CSV serializer",
        definition_of_done: "A unit test writes a CSV matching the fixture",
        depends_on: [],
        extra: "drop-me",
      },
    ],
    extra_plan: "drop-me",
  })}\n`,
);
