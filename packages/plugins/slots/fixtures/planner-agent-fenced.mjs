#!/usr/bin/env node
// Agents fence JSON as often as they write it plain.
import { writeFileSync } from "node:fs";

const out = /(\S*plan\.json)/.exec(process.argv.at(-1) ?? "")?.[1];
writeFileSync(
  out,
  [
    "Here is the plan:",
    "```json",
    JSON.stringify({
      subtasks: [
        {
          id: "only",
          intention: "the whole thing",
          definition_of_done: "it works",
          depends_on: [],
        },
      ],
    }),
    "```",
  ].join("\n"),
);
