#!/usr/bin/env node
/**
 * Mechanical kernel contract. The prose lives in kernel/README.md.
 *
 * Every package under kernel/ is published on its own, so it must stand on its
 * own: a source file imports only Node, a declared dependency, or a file of
 * the same package; the only @bluewombat dependency is the one the README
 * allows; every published entry point sits inside `files`; tests exist.
 * Transformers (§ Transformers) carry the two faces on top of that.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const KERNEL = join(ROOT, "packages", "kernel");
/** Directory names under kernel/ that are Transformers. */
const TRANSFORMER_DIRS = ["isolator", "implementer", "integrator", "feature-breakdown"];
/** The only @bluewombat dependencies a kernel package may declare or import. */
const ALLOWED_KERNEL_DEPS = { conductor: ["@bluewombat/work-ledger"] };
const REQUIRED_FILES = ["package.json", "README.md", "src/index.ts", "tsconfig.json"];
const TRANSFORMER_FILES = ["SPECS.md", "src/cli.ts"];
const DEP_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];
/** Static `import … from`, `export … from`, side-effect `import "x"`, and `import("x")`. */
const importSpecifiers = [
  /^\s*(?:import|export)\b[^;'"]*?\bfrom\s+["']([^"']+)["']/gm,
  /^\s*import\s+["']([^"']+)["']/gm,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
];

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function sourceFiles(dir) {
  return readdirSync(dir, { recursive: true })
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(dir, name));
}

function insideFiles(target, files) {
  const path = target.replace(/^\.\//, "");
  return files.some((entry) => path === entry || path.startsWith(`${entry.replace(/\/$/, "")}/`));
}

function* entryPoints(manifest) {
  const walk = function* (value, where) {
    if (typeof value === "string") {
      yield [where, value];
    } else if (value && typeof value === "object") {
      for (const [key, inner] of Object.entries(value)) {
        yield* walk(inner, `${where}.${key}`);
      }
    }
  };
  yield* walk(manifest.exports, "exports");
  yield* walk(manifest.bin, "bin");
  yield* walk(manifest.types, "types");
  yield* walk(manifest.main, "main");
}

const packages = readdirSync(KERNEL).filter((name) => statSync(join(KERNEL, name)).isDirectory());

for (const pkg of packages) {
  const dir = join(KERNEL, pkg);
  const name = `packages/kernel/${pkg}`;
  const isTransformer = TRANSFORMER_DIRS.includes(pkg);
  const required = isTransformer ? [...REQUIRED_FILES, ...TRANSFORMER_FILES] : REQUIRED_FILES;
  for (const file of required) {
    if (!existsSync(join(dir, file))) {
      fail(`${name}: missing ${file}`);
    }
  }
  if (!existsSync(join(dir, "package.json"))) {
    continue;
  }
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));

  // Publishable shape.
  if (manifest.exports === undefined) {
    fail(`${name}: package.json has no exports`);
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    fail(`${name}: package.json has no files`);
  }
  if (manifest.publishConfig?.access !== "public") {
    fail(`${name}: package.json publishConfig.access is not "public"`);
  }
  if (manifest.repository?.directory !== name) {
    fail(`${name}: package.json repository.directory is not "${name}"`);
  }
  if (isTransformer && (manifest.bin === undefined || Object.keys(manifest.bin).length === 0)) {
    fail(`${name}: package.json has no bin`);
  }
  for (const [where, target] of entryPoints(manifest)) {
    if (Array.isArray(manifest.files) && !insideFiles(target, manifest.files)) {
      fail(`${name}: ${where} points to ${target}, outside files`);
    }
  }

  // Declared dependencies.
  const allowed = ALLOWED_KERNEL_DEPS[pkg] ?? [];
  const declared = new Set();
  for (const section of DEP_SECTIONS) {
    for (const dep of Object.keys(manifest[section] ?? {})) {
      declared.add(dep);
      if (dep.startsWith("@bluewombat/") && !allowed.includes(dep)) {
        fail(`${name}: must not depend on ${dep} (${section})`);
      }
    }
  }

  // Imports: Node, a declared dependency, or a file of this package.
  const src = join(dir, "src");
  const files = existsSync(src) ? sourceFiles(src) : [];
  if (!files.some((file) => file.endsWith(".test.ts"))) {
    fail(`${name}: no test under src/`);
  }
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const at = relative(ROOT, file);
    const specifiers = importSpecifiers.flatMap((pattern) =>
      [...source.matchAll(pattern)].map((match) => match[1] ?? ""),
    );
    for (const specifier of specifiers) {
      if (specifier.startsWith("node:")) {
        continue;
      }
      if (specifier.startsWith(".") || isAbsolute(specifier)) {
        const target = resolve(dirname(file), specifier);
        if (relative(dir, target).startsWith("..") || isAbsolute(specifier)) {
          fail(`${at}: imports ${specifier}, outside ${name}`);
        }
        continue;
      }
      const bare = specifier.startsWith("@")
        ? specifier.split("/").slice(0, 2).join("/")
        : specifier.split("/")[0];
      if (!declared.has(bare)) {
        fail(`${at}: imports ${specifier}, not a dependency of ${name}`);
      }
    }
  }
}

if (process.exitCode) {
  process.stderr.write("Kernel contract failed. See kernel/README.md.\n");
} else {
  process.stdout.write(`Checked ${packages.length} kernel packages.\n`);
}
