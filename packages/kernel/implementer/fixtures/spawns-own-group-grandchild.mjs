#!/usr/bin/env node
// Starts a grandchild in a process group of its own, the way cursor-agent runs
// each shell command, then waits. argv[2]: file that receives the grandchild's pid.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
  stdio: "ignore",
  detached: true,
});
writeFileSync(process.argv[2], String(grandchild.pid));
setTimeout(() => {}, 60000);
