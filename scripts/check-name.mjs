#!/usr/bin/env node
/**
 * The product's name is written in one source file and nowhere else:
 *
 *   packages/host/manager-kit/src/product.ts  PRODUCT — Host and every manager read it
 *
 * Every package.json `bin` must be that word, and a `<name>-manager` keyword
 * must use it. Tests, fixtures and docs may say the name; they are not what a
 * rename has to catch. A branch is named after the item it works on, never
 * after the tool: `REF_PREFIX` in isolation-git is not the product's name.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PRODUCT_FILE = "packages/host/manager-kit/src/product.ts";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function constant(file, pattern) {
  const match = pattern.exec(readFileSync(join(ROOT, file), "utf8"));
  if (match === null) {
    fail(`${file}: no constant found`);
    return undefined;
  }
  return match[1];
}

const product = constant(PRODUCT_FILE, /export const PRODUCT = "([a-z][a-z0-9-]*)";/);

const sources = readdirSync(join(ROOT, "packages"), { recursive: true })
  .filter((name) => /\.(ts|mjs)$/.test(name))
  .filter((name) => !name.includes("node_modules") && !/(^|\/)dist\//.test(name))
  .filter((name) => !name.endsWith(".test.ts") && !/(^|\/)(test|fixtures)\//.test(name))
  .map((name) => join("packages", name));
const word = product === undefined ? undefined : new RegExp(`\\b${product}\\b`, "i");
for (const file of sources) {
  if (file === PRODUCT_FILE || word === undefined) {
    continue;
  }
  const source = readFileSync(join(ROOT, file), "utf8");
  // Comments may name the product; code must read the constant.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/`([^`]*)`/g, (m) => m.replace(/\$\{[^}]*\}/g, ""));
  if (word.test(code)) {
    fail(`${file}: spells "${product}" — read PRODUCT from @bluewombat/manager-kit`);
  }
}

for (const dir of readdirSync(join(ROOT, "packages"), { withFileTypes: true, recursive: true })) {
  if (!dir.isFile() || dir.name !== "package.json" || dir.parentPath.includes("node_modules")) {
    continue;
  }
  const path = join(dir.parentPath, "package.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  for (const bin of Object.keys(manifest.bin ?? {})) {
    if (manifest.name.endsWith("/runtime") && bin !== product) {
      fail(`${relative(ROOT, path)}: bin is "${bin}", PRODUCT is "${product}"`);
    }
  }
  for (const keyword of manifest.keywords ?? []) {
    if (/-manager$/.test(keyword) && keyword !== `${product}-manager`) {
      fail(`${relative(ROOT, path)}: keyword "${keyword}" does not use PRODUCT`);
    }
  }
}

if (process.exitCode) {
  process.stderr.write(
    "Product name check failed. The name lives in one constant; see scripts/check-name.mjs.\n",
  );
} else {
  process.stdout.write(`Checked ${sources.length} source files: the product is "${product}".\n`);
}
