#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Plays `deck materialize --json` for the agent wrapper tests. It records its
// argv in the project (-C), then answers like deck 1.0: one plugin folder per
// id under --out, and the profile's prompt path when the profile has one.
// DECK_FAKE_MODE=fail answers like a lock that does not pin a request.
const args = process.argv.slice(2);
const value = (flag) => {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
};
const project = value("-C") ?? process.cwd();
writeFileSync(join(project, "deck-args.json"), JSON.stringify(args));
if (process.env.DECK_FAKE_MODE === "fail") {
  process.stderr.write("impeccable not pinned by a lock. Run deck install (or deck add) first.\n");
  process.exit(1);
}
const out = value("--out");
const profile = value("--profile") ?? null;
const ids = profile === null ? ["git-workflow"] : ["git-workflow", `${profile}-kit`];
const plugins = ids.map((id) => {
  const path = join(out, id);
  mkdirSync(join(path, ".cursor-plugin"), { recursive: true });
  writeFileSync(join(path, ".cursor-plugin", "plugin.json"), JSON.stringify({ name: id }));
  return { id, path, integrity: `sha256-${id}`, components: { skills: [id] } };
});
const promptPath = profile === null ? null : join(project, ".ai", "profiles", profile, "prompt.md");
process.stdout.write(
  `${JSON.stringify({
    profile,
    prompt: promptPath !== null && existsSync(promptPath) ? promptPath : null,
    out,
    plugins,
  })}\n`,
);
