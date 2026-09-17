#!/usr/bin/env node
// Stands in for an agent CLI: reads the answer path out of the prompt and
// writes a usable plan there.
import { writeFileSync } from "node:fs";

const prompt = process.argv.at(-1) ?? "";
const out = /(\S*plan\.json)/.exec(prompt)?.[1];
writeFileSync(
  out,
  JSON.stringify({
    subtasks: [
      {
        id: "s1",
        intention: "first slice",
        definition_of_done: "a test covers it",
        depends_on: [],
      },
      {
        id: "s2",
        intention: "second slice",
        definition_of_done: "a test covers it",
        depends_on: ["s1"],
      },
    ],
  }),
);
process.stdout.write(`${JSON.stringify({ type: "result", is_error: false })}\n`);
