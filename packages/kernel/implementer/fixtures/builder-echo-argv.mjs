#!/usr/bin/env node
/** Writes the argv it was given to `argv.json` in the workspace, then passes. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

writeFileSync(join(process.cwd(), "argv.json"), JSON.stringify(process.argv.slice(2)));
process.exit(0);
