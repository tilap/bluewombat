#!/usr/bin/env node
import { writeFileSync } from "node:fs";

writeFileSync("delivered.txt", "work done\n");
process.exit(0);
