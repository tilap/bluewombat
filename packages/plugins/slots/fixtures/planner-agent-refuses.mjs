#!/usr/bin/env node
import { writeFileSync } from "node:fs";

const out = /(\S*plan\.json)/.exec(process.argv.at(-1) ?? "")?.[1];
writeFileSync(
  out,
  JSON.stringify({ outcome: "refused", reason: "It asks for two opposite results." }),
);
