#!/usr/bin/env node
/**
 * Passes on odd Attempts, fail-retryable on even — forces a second Attempt
 * while still proving Gates restart from the first.
 * Appends its gate-id + attempt to a marker file in the workspace.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const attemptIdx = args.indexOf("--attempt");
const attempt = attemptIdx >= 0 ? Number(args[attemptIdx + 1]) : 1;
const gateIdx = args.indexOf("--gate-id");
const gateId = gateIdx >= 0 ? args[gateIdx + 1] : "unknown";

appendFileSync(join(process.cwd(), "gate-runs.txt"), `${gateId}:${attempt}\n`);

if (gateId === "first") {
  process.stdout.write(`${JSON.stringify({ verdict: "pass" })}\n`);
  process.exit(0);
}

// second gate: fail once, then pass
if (attempt === 1) {
  process.stdout.write(
    `${JSON.stringify({ verdict: "fail-retryable", report: "second failed once" })}\n`,
  );
  process.exit(0);
}
process.stdout.write(`${JSON.stringify({ verdict: "pass" })}\n`);
