#!/usr/bin/env node
import { writeFileSync } from "node:fs";

writeFileSync("delivered.txt", "ok\n");
process.stdout.write(`${JSON.stringify({ type: "result", is_error: false, result: "done" })}\n`);
process.exit(0);
