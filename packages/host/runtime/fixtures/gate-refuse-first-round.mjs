#!/usr/bin/env node
// Refuses the first round it ever sees of a workspace, takes every later one —
// an Authority's judge that changes its mind once the work was repaired.
import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const flag = join(tmpdir(), `refused-${createHash("sha1").update(process.cwd()).digest("hex")}`);
if (existsSync(flag)) {
  process.stdout.write(`${JSON.stringify({ verdict: "pass" })}\n`);
} else {
  writeFileSync(flag, "");
  process.stdout.write(`${JSON.stringify({ verdict: "fail-retryable", report: "lint failed" })}\n`);
}
