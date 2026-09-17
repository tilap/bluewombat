#!/usr/bin/env node
/** Sleeps longer than typical Attempt clocks — used for timeout tests. */
const ms = Number(process.argv[2] ?? "60000");
await new Promise((resolve) => setTimeout(resolve, ms));
process.exit(0);
