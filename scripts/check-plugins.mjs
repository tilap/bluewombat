#!/usr/bin/env node
/**
 * Mechanical plugin contract. The prose lives in packages/plugins/README.md.
 *
 * A plugin is loaded by Host, or spawned by a Transformer, by the name a
 * config gives. It answers a contract and knows nothing of who calls it: a
 * plugin imports its kit (`@bluewombat/manager-kit`, `@bluewombat/slot-kit`) and
 * the kernel packages whose Ports it implements — never `@bluewombat/runtime`,
 * never another plugin. A test may import anything: it is where a caller is
 * played on purpose.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGINS = join(ROOT, "packages", "plugins");
const DEP_SECTIONS = ["dependencies", "peerDependencies", "optionalDependencies"];
const FORBIDDEN = ["@bluewombat/runtime"];
const importSpecifiers = [
  /^\s*(?:import|export)\b[^;'"]*?\bfrom\s+["']([^"']+)["']/gm,
  /^\s*import\s+["']([^"']+)["']/gm,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
];

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

const packages = readdirSync(PLUGINS).filter((name) => statSync(join(PLUGINS, name)).isDirectory());
const pluginNames = new Set(
  packages.map((pkg) => JSON.parse(readFileSync(join(PLUGINS, pkg, "package.json"), "utf8")).name),
);

function isForbidden(dep, self) {
  return dep !== self && (FORBIDDEN.includes(dep) || pluginNames.has(dep));
}

for (const pkg of packages) {
  const dir = join(PLUGINS, pkg);
  const name = `packages/plugins/${pkg}`;
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  if (manifest.repository?.directory !== name) {
    fail(`${name}: package.json repository.directory is not "${name}"`);
  }
  for (const section of DEP_SECTIONS) {
    for (const dep of Object.keys(manifest[section] ?? {})) {
      if (isForbidden(dep, manifest.name)) {
        fail(
          `${name}: must not depend on ${dep} (${section}) — a plugin knows its kit, not its caller`,
        );
      }
    }
  }
  // Sources: .ts under src/ and the .mjs a slots-style package ships directly.
  const files = readdirSync(dir, { recursive: true })
    .filter(
      (file) =>
        (file.endsWith(".ts") || file.endsWith(".mjs")) &&
        !file.includes("node_modules") &&
        !file.startsWith("dist"),
    )
    .map((file) => join(dir, file));
  for (const file of files) {
    if (
      file.endsWith(".test.ts") ||
      file.includes(`${join(dir, "test")}/`) ||
      file.includes(`${join(dir, "fixtures")}/`)
    ) {
      continue;
    }
    const source = readFileSync(file, "utf8");
    const at = relative(ROOT, file);
    for (const pattern of importSpecifiers) {
      for (const match of source.matchAll(pattern)) {
        const specifier = match[1] ?? "";
        if (!specifier.startsWith("@")) {
          continue;
        }
        const bare = specifier.split("/").slice(0, 2).join("/");
        if (isForbidden(bare, manifest.name)) {
          fail(`${at}: imports ${specifier} — a plugin knows its kit, not its caller`);
        }
      }
    }
  }
  if (!existsSync(join(dir, "README.md"))) {
    fail(`${name}: missing README.md`);
  }
}

if (process.exitCode) {
  process.stderr.write("Plugin contract failed. See packages/plugins/README.md.\n");
} else {
  process.stdout.write(`Checked ${packages.length} plugins.\n`);
}
