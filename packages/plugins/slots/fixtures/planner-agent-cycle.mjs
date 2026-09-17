#!/usr/bin/env node
import { writeFileSync } from "node:fs";

const out = /(\S*plan\.json)/.exec(process.argv.at(-1) ?? "")?.[1];
writeFileSync(
  out,
  JSON.stringify({
    subtasks: [
      { id: "a", intention: "a", definition_of_done: "a", depends_on: ["b"] },
      { id: "b", intention: "b", definition_of_done: "b", depends_on: ["a"] },
    ],
  }),
);
