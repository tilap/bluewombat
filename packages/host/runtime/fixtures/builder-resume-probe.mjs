#!/usr/bin/env node
/**
 * One producer for the tests of a stopped and resumed run. It logs its argv and what was in the
 * workspace when it started, to `probe.log` in the workspace, then does what its first argument
 * says: `hang-after-half` leaves half of the work and waits to be killed or stopped, `finish`
 * delivers (and says whether it found the half), `write-then-hang` delivers and then waits to be
 * killed, as a producer does that finished and is still verifying.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const mode = process.argv[2];
const args = process.argv.slice(3);
appendFileSync("probe.log", `${JSON.stringify({ mode, half: existsSync("half.txt"), args })}\n`);
if (mode === "hang-after-half") {
  writeFileSync("half.txt", "half of the work\n");
  await new Promise((resolve) => setTimeout(resolve, 60_000));
}
if (mode === "write-then-hang") {
  writeFileSync("delivered.txt", "work done\n");
  await new Promise((resolve) => setTimeout(resolve, 60_000));
}
if (mode === "finish") {
  writeFileSync("delivered.txt", "work done\n");
  // These land with the ticket, so a test can read what this producer found and was told.
  writeFileSync(
    "found-half.txt",
    existsSync("half.txt") ? readFileSync("half.txt", "utf8") : "none\n",
  );
  writeFileSync("told.json", `${JSON.stringify(args)}\n`);
}
process.exit(0);
