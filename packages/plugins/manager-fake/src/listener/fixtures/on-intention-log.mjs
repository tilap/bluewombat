#!/usr/bin/env node
// Appends one line per Delivery to the file named by ON_INTENTION_LOG.
import { appendFileSync } from "node:fs";

const target = process.env.ON_INTENTION_LOG;
if (target) {
  appendFileSync(target, `${process.argv.slice(2).join(" ")}\n`);
}
