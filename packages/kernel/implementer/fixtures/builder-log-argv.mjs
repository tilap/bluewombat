#!/usr/bin/env node
/**
 * Logs its argv, one JSON line per call, to `argv.log` in the workspace.
 * `hang-first` makes Attempt 1 outlast any clock; `say:TEXT` makes it say TEXT on a clean exit.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
appendFileSync(join(process.cwd(), "argv.log"), `${JSON.stringify(args)}\n`);
const attempt = args[args.indexOf("--attempt") + 1];
if (args.includes("hang-first") && attempt === "1") {
  await new Promise((resolve) => setTimeout(resolve, 60_000));
}
const say = args.find((arg) => arg.startsWith("say:"));
if (say !== undefined) {
  process.stdout.write(`${JSON.stringify({ said: say.slice(4) })}\n`);
}
process.exit(0);
