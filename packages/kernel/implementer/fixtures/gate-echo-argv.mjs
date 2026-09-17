#!/usr/bin/env node
/** Writes the argv it was given to `gate-argv.json` in the workspace, then passes. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

writeFileSync(join(process.cwd(), "gate-argv.json"), JSON.stringify(process.argv.slice(2)));
process.stdout.write(`${JSON.stringify({ verdict: "pass" })}\n`);
