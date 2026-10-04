#!/usr/bin/env node
// Starts a grandchild that shares our pipes and outlives a plain kill of this
// process, then waits. argv[2]: file that receives the grandchild's pid.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
  stdio: "inherit",
});
writeFileSync(process.argv[2], String(grandchild.pid));
setTimeout(() => {}, 60000);
