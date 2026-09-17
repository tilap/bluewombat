import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PRODUCT } from "@bluewombat/manager-kit";

/**
 * How Host loads anything a Project names in its config: a manager, an
 * isolation strategy, whatever comes next. One loader, one set of resolution
 * rules, one wording for a package that is missing. What differs per kind is
 * only the shape the module must have, and that is the `Shape` handed in.
 *
 * Resolution: a relative or absolute name is a file. A bare name is imported
 * the normal way first — mason and its plugins installed side by side in one
 * project — then looked for by walking `node_modules` up from `fromDir`, which
 * covers a globally installed `mason` driving a plugin installed next to the
 * config file.
 */

/** What one kind of plugin must look like once imported. */
export type Shape<T> = {
  /** How the kind is called in a refusal: `Manager`, `Isolation strategy`. */
  kind: string;
  /** Read the module; `reason` says what is missing, without naming the file. */
  check(loaded: unknown): { ok: true; value: T } | { ok: false; reason: string };
};

export type Loaded<T> = { ok: true; value: T; specifier: string } | { ok: false; reason: string };

export async function loadPlugin<T>(
  name: string,
  fromDir: string,
  shape: Shape<T>,
): Promise<Loaded<T>> {
  const attempts: string[] = [];

  if (name.startsWith(".") || isAbsolute(name)) {
    const path = resolve(fromDir, name);
    if (!existsSync(path)) {
      return { ok: false, reason: `${shape.kind} "${name}" is not a file: ${path}` };
    }
    return await importFrom(pathToFileURL(path).href, name, shape, attempts);
  }

  const direct = await importFrom(name, name, shape, attempts);
  if (direct.ok) {
    return direct;
  }
  const nearby = findInNodeModules(name, fromDir);
  if (nearby === undefined) {
    return {
      ok: false,
      reason:
        `${shape.kind} "${name}" could not be loaded. Install it next to ${PRODUCT} ` +
        `(npm install ${name}).\n${attempts.join("\n")}`,
    };
  }
  return await importFrom(pathToFileURL(nearby).href, name, shape, attempts);
}

async function importFrom<T>(
  url: string,
  name: string,
  shape: Shape<T>,
  attempts: string[],
): Promise<Loaded<T>> {
  let loaded: unknown;
  try {
    loaded = await import(url);
  } catch (error) {
    attempts.push(`  ${url}: ${error instanceof Error ? error.message : String(error)}`);
    return { ok: false, reason: attempts.join("\n") };
  }
  const checked = shape.check(loaded);
  if (!checked.ok) {
    return { ok: false, reason: `${shape.kind} "${name}" ${checked.reason} (${name}).` };
  }
  return { ok: true, value: checked.value, specifier: name };
}

/** The entry file of `<dir>/node_modules/<specifier>`, walking up from `from`. */
function findInNodeModules(specifier: string, from: string): string | undefined {
  let dir = resolve(from);
  for (;;) {
    const packageRoot = join(dir, "node_modules", specifier);
    const manifest = join(packageRoot, "package.json");
    if (existsSync(manifest)) {
      const entry = entryOf(manifest);
      if (entry !== undefined) {
        const path = resolve(packageRoot, entry);
        if (existsSync(path)) {
          return path;
        }
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

function entryOf(manifest: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifest, "utf8"));
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") {
    return undefined;
  }
  const object = parsed as { exports?: unknown; module?: unknown; main?: unknown };
  const root = readExports(object.exports);
  if (root !== undefined) {
    return root;
  }
  if (typeof object.module === "string") {
    return object.module;
  }
  return typeof object.main === "string" ? object.main : undefined;
}

function readExports(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const root = (value as Record<string, unknown>)["."] ?? value;
  if (typeof root === "string") {
    return root;
  }
  if (root === null || typeof root !== "object") {
    return undefined;
  }
  const conditions = root as Record<string, unknown>;
  for (const key of ["import", "module", "default"]) {
    const candidate = conditions[key];
    if (typeof candidate === "string") {
      return candidate;
    }
  }
  return undefined;
}
