#!/usr/bin/env node
import { writeFileSync } from "node:fs";

writeFileSync("delivered.txt", "subtask done\n");
process.exit(0);
