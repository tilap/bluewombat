#!/usr/bin/env node
/** Builder that says something on each stream before passing. */
import { writeSync } from "node:fs";

writeSync(1, "on stdout\n");
writeSync(2, "on stderr\n");
process.exit(0);
