#!/usr/bin/env node
const ms = Number(process.argv[2] ?? "60000");
await new Promise((resolve) => setTimeout(resolve, ms));
process.stdout.write(`${JSON.stringify({ verdict: "pass" })}\n`);
