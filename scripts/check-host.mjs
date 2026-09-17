#!/usr/bin/env node
/**
 * Mechanical Host layering. The prose lives in packages/host/runtime/README.md § Layers.
 *
 * Host is four layers, and imports point one way:
 *
 *   operator → loop → plugins → config
 *
 * A file imports from its own layer or a lower one, never a higher one. The
 * two files at the top of src/ (index.ts, cli.ts) see everything. A test file
 * obeys the same rule as the source next to it.
 *
 * And Host's code names no plugin: a manager, an isolation strategy, a
 * persistence backend, the shipped slots are loaded by the name a config
 * gives, never imported. A kit (`manager-kit`, `slot-kit`) is a contract,
 * not a plugin, and may be imported. The names Host falls back to live in one file,
 * config/defaults.ts, as strings. A test may import a plugin: it is the one
 * place a real one is wanted on purpose.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "packages", "host", "runtime", "src");
/** Lowest first. A layer may import itself and anything before it. */
const LAYERS = ["config", "plugins", "loop", "operator"];
/** Files directly under src/: the package surface, above every layer. */
const TOP_FILES = ["index.ts", "cli.ts"];
/** Packages Host loads by name and must not import. Prefixes. */
const PLUGIN_PREFIXES = [
  "@bluewombat/manager-",
  "@bluewombat/isolation-",
  "@bluewombat/persist-",
  "@bluewombat/slots",
];
/** Contracts, not plugins: a kit shares a prefix with the plugins it serves. */
const KITS = ["@bluewombat/manager-kit", "@bluewombat/slot-kit"];
function isPlugin(specifier) {
  const bare = specifier.split("/").slice(0, 2).join("/");
  return !KITS.includes(bare) && PLUGIN_PREFIXES.some((prefix) => specifier.startsWith(prefix));
}
/** The one source file allowed to spell a plugin's name — as a string, not an import. */
const DEFAULTS_FILE = "config/defaults.ts";
const importSpecifiers = [
  /^\s*(?:import|export)\b[^;'"]*?\bfrom\s+["']([^"']+)["']/gm,
  /^\s*import\s+["']([^"']+)["']/gm,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
];

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

/** The layer a path under src/ belongs to, or `undefined` for a top file. */
function layerOf(path) {
  const [first] = relative(SRC, path).split("/");
  return LAYERS.includes(first) ? first : undefined;
}

const entries = readdirSync(SRC, { withFileTypes: true });
for (const entry of entries) {
  if (entry.isDirectory() && !LAYERS.includes(entry.name)) {
    fail(`packages/host/runtime/src/${entry.name}: not a layer (${LAYERS.join(", ")})`);
  }
  if (entry.isFile() && entry.name.endsWith(".ts") && !TOP_FILES.includes(entry.name)) {
    fail(
      `packages/host/runtime/src/${entry.name}: only ${TOP_FILES.join(" and ")} sit above the layers`,
    );
  }
}

const files = readdirSync(SRC, { recursive: true })
  .filter((name) => name.endsWith(".ts"))
  .map((name) => join(SRC, name));
let checked = 0;
for (const file of files) {
  const from = layerOf(file);
  const source = readFileSync(file, "utf8");
  const at = relative(ROOT, file);
  const specifiers = importSpecifiers.flatMap((pattern) =>
    [...source.matchAll(pattern)].map((match) => match[1] ?? ""),
  );
  const isTest = file.endsWith(".test.ts");
  for (const specifier of specifiers) {
    if (!specifier.startsWith(".")) {
      if (!isTest && isPlugin(specifier)) {
        fail(`${at}: imports ${specifier} — Host loads a plugin by name, it does not import one`);
      }
      continue;
    }
    const target = resolve(dirname(file), specifier);
    if (relative(SRC, target).startsWith("..")) {
      // Outside src/: a fixture, a sibling package's file. Not a layer question.
      continue;
    }
    const to = layerOf(target);
    if (to === undefined) {
      fail(`${at}: imports ${specifier}, a top file — nothing imports index.ts or cli.ts`);
      continue;
    }
    if (from === undefined) {
      continue;
    }
    if (LAYERS.indexOf(to) > LAYERS.indexOf(from)) {
      fail(`${at}: ${from} imports ${specifier} (${to}) — imports go ${LAYERS.join(" ← ")}`);
    }
    checked += 1;
  }
}

// A plugin's name written anywhere but defaults.ts is a default in hiding.
for (const file of files) {
  if (file.endsWith(".test.ts") || relative(SRC, file) === DEFAULTS_FILE) {
    continue;
  }
  const source = readFileSync(file, "utf8");
  // Quoted, so a doc comment may still say which package is meant.
  for (const quoted of source.matchAll(/["'](@bluewombat\/[\w-]+)/g)) {
    const name = quoted[1] ?? "";
    if (isPlugin(name)) {
      fail(`${relative(ROOT, file)}: spells ${name} — plugin names live in ${DEFAULTS_FILE}`);
    }
  }
}

if (process.exitCode) {
  process.stderr.write("Host layering failed. See packages/host/runtime/README.md § Layers.\n");
} else {
  process.stdout.write(`Checked ${files.length} Host files, ${checked} layer imports.\n`);
}
