#!/usr/bin/env node
/**
 * Writes the name it was given, so a test can see which producer ran.
 * Usage: builder-mark.mjs <name>
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";

appendFileSync(join(process.cwd(), "producers.txt"), `${process.argv[2]}\n`);
process.exit(0);
