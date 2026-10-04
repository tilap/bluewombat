#!/usr/bin/env node
/**
 * Mechanical contract for ending a child's whole process tree.
 *
 * The prose lives in scripts/templates/process-tree.ts. In short: whoever
 * starts a child and owns its deadline starts it as the leader of its own
 * process group and ends it by signalling the group; killing only the child
 * leaves what it started running and holding its pipes, so a deadline means
 * nothing. A package stands alone, so each carries a copy of that one file.
 *
 *   node scripts/check-process-tree.mjs          check
 *   node scripts/check-process-tree.mjs --write  refresh every copy
 *
 * Checked, over the sources of packages/ (tests excepted):
 *  - every `process-tree.ts` is identical to the template;
 *  - a child's `.kill(` is called only there, unless the line is marked `process-tree:allow`;
 *  - a file that calls `spawn(` imports its `process-tree`, or says
 *    `process-tree:layer`: it is a layer inside someone else's group;
 *  - `spawnSync` is not given a `timeout`: it stops the command and waits for
 *    the rest of the tree on its pipes. A supervised run is asynchronous.
 */
import { copyFileSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = join(ROOT, "scripts", "templates", "process-tree.ts");
const SKIP = new Set(["node_modules", "dist", ".turbo"]);

function walk(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) {
      continue;
    }
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(path, found);
    } else if (entry.name.endsWith(".ts")) {
      found.push(path);
    }
  }
  return found;
}

const write = process.argv.includes("--write");
const template = readFileSync(TEMPLATE, "utf8");
const problems = [];
const files = walk(join(ROOT, "packages")).filter(
  (file) => file.split("/src/").length > 1 && !/\.test\.ts$/.test(file),
);

for (const file of files) {
  const name = relative(ROOT, file);
  const text = readFileSync(file, "utf8");
  if (file.endsWith("/process-tree.ts")) {
    if (text !== template) {
      if (write) {
        copyFileSync(TEMPLATE, file);
        process.stdout.write(`refreshed ${name}\n`);
      } else {
        problems.push(`${name}: differs from scripts/templates/process-tree.ts (run with --write)`);
      }
    }
    continue;
  }
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    if (/(?<!process)\.kill\(/.test(line) && !line.includes("process-tree:allow")) {
      const marked =
        lines[index - 1]?.includes("process-tree:allow") ||
        lines[index - 2]?.includes("process-tree:allow");
      if (!marked) {
        problems.push(`${name}:${index + 1}: .kill( — use killTree / killAndCut from process-tree`);
      }
    }
  });
  if (
    /\bspawn\(/.test(text) &&
    !/process-tree(\.js)?["']/.test(text) &&
    !text.includes("process-tree:layer")
  ) {
    problems.push(
      `${name}: calls spawn( without process-tree (import it, or mark the file process-tree:layer)`,
    );
  }
  if (/\bspawnSync\(/.test(text) && /\btimeout\b\s*:/.test(text)) {
    problems.push(
      `${name}: spawnSync with a timeout does not end the tree — run it asynchronously with process-tree`,
    );
  }
}

if (problems.length > 0) {
  for (const problem of problems) {
    process.stderr.write(`${problem}\n`);
  }
  process.exitCode = 1;
} else if (!write) {
  const copies = files.filter((file) => file.endsWith("/process-tree.ts")).length;
  process.stdout.write(`Checked ${copies} process-tree copies and ${files.length} sources.\n`);
}
