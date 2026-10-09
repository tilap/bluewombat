#!/usr/bin/env node
import { writeFileSync } from "node:fs";

// A marker in cwd (the Gate's --workspace) proves whether this Gate ran at all.
writeFileSync("gate-ran.txt", "yes");
process.stdout.write(`${JSON.stringify({ verdict: "pass" })}\n`);
