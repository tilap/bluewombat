#!/usr/bin/env node
import { writeFileSync } from "node:fs";

// Only the keys the agent-isolation tests assert. Never dump process.env:
// it can hold the operator's API key.
const PICKED = [
  "HOME",
  "PATH",
  "AGENT_CLI_CREDENTIAL_STORE",
  "CURSOR_API_KEY",
  "COREPACK_HOME",
  "GIT_CONFIG_GLOBAL",
  "npm_config_cache",
  "LANG",
  "SSH_AUTH_SOCK",
  "MASON_TEST_SECRET",
  "MASON_TEST_PASS",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_VALUE_0",
  "GIT_TERMINAL_PROMPT",
];
const env = {};
for (const key of PICKED) {
  if (Object.hasOwn(process.env, key)) {
    env[key] = process.env[key];
  }
}
writeFileSync("argv.json", JSON.stringify(process.argv.slice(2)));
writeFileSync("env.json", JSON.stringify(env));
process.stdout.write(`${JSON.stringify({ type: "result", is_error: false, result: "done" })}\n`);
process.exit(0);
