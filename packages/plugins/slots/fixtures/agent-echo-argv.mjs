#!/usr/bin/env node
import { writeFileSync } from "node:fs";

writeFileSync("argv.json", JSON.stringify(process.argv.slice(2)));
process.stdout.write(`${JSON.stringify({ type: "result", is_error: false, result: "done" })}\n`);
process.exit(0);
