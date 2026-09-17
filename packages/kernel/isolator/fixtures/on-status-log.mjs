#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const labelIdx = args.indexOf("--label");
const label = labelIdx >= 0 ? args[labelIdx + 1] : "";
const out = process.env.ON_STATUS_LOG;
if (out) {
  appendFileSync(out, `${label}\n`);
}
