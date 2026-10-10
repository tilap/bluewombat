#!/usr/bin/env node
/**
 * Versions for the whole repository, in lockstep.
 *
 * Every `@bluewombat/*` package is one product cut at one moment, so they carry
 * the same version and depend on each other by that exact number. One script
 * writes it everywhere; nothing else has to stay in sync by hand.
 *
 *   node scripts/release.mjs set 0.2.0       write the version everywhere
 *   node scripts/release.mjs check 0.2.0     fail unless it is already there
 *   node scripts/release.mjs publish 0.2.0   CI only. The Release workflow calls this
 *                                            after a v* tag. It is not a local release —
 *                                            docs/RUNBOOKS.md § Deploy.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKSPACE_DIRS = ["packages/kernel", "packages/host", "packages/plugins"];
const SCOPE = "@bluewombat/";
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function manifests() {
  const found = [];
  for (const workspace of WORKSPACE_DIRS) {
    const base = join(ROOT, workspace);
    for (const entry of readdirSync(base)) {
      const path = join(base, entry, "package.json");
      try {
        if (statSync(path).isFile()) {
          found.push(path);
        }
      } catch {
        // Not a package directory.
      }
    }
  }
  return found.sort();
}

function read(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function setVersion(version) {
  for (const path of manifests()) {
    const manifest = read(path);
    manifest.version = version;
    for (const section of ["dependencies", "devDependencies", "peerDependencies"]) {
      const deps = manifest[section];
      if (deps === undefined) {
        continue;
      }
      for (const name of Object.keys(deps)) {
        if (name.startsWith(SCOPE)) {
          deps[name] = `^${version}`;
        }
      }
    }
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  process.stdout.write(`Set ${manifests().length} packages to ${version}.\n`);
  process.stdout.write("Now run: npm install --package-lock-only\n");
}

function check(version) {
  const problems = [];
  for (const path of manifests()) {
    const manifest = read(path);
    const where = path.slice(ROOT.length + 1);
    if (manifest.private === true) {
      problems.push(`${where}: still private, so it will never publish`);
      continue;
    }
    if (manifest.version !== version) {
      problems.push(`${where}: version ${manifest.version}, expected ${version}`);
    }
    if (manifest.license === undefined) {
      problems.push(`${where}: no license field`);
    }
    if (manifest.files === undefined) {
      problems.push(`${where}: no files field, so the whole directory would publish`);
    }
    for (const section of ["dependencies", "peerDependencies"]) {
      for (const [name, range] of Object.entries(manifest[section] ?? {})) {
        if (name.startsWith(SCOPE) && range !== `^${version}`) {
          problems.push(`${where}: ${name} is ${range}, expected ^${version}`);
        }
      }
    }
  }
  if (problems.length > 0) {
    process.stderr.write(`${problems.join("\n")}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`All packages are ready to publish at ${version}.\n`);
}

function alreadyOnRegistry(name, version) {
  const result = spawnSync("npm", ["view", `${name}@${version}`, "version"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return result.status === 0 && result.stdout.trim() === version;
}

function publish(version) {
  check(version);
  if (process.exitCode) {
    return;
  }
  for (const path of manifests()) {
    const name = read(path).name;
    if (alreadyOnRegistry(name, version)) {
      process.stdout.write(
        `${name}@${version} is already on the registry — not publishing again.\n`,
      );
      continue;
    }
    const result = spawnSync("npm", ["publish", "--workspace", name, "--access", "public"], {
      cwd: ROOT,
      stdio: "inherit",
    });
    if (result.status !== 0) {
      process.stderr.write(`${name}: npm publish exited ${result.status}\n`);
      process.exitCode = result.status ?? 1;
      return;
    }
  }
}

const [command, version] = process.argv.slice(2);
if (version === undefined || !VERSION_PATTERN.test(version)) {
  process.stderr.write("Usage: node scripts/release.mjs <set|check|publish> <x.y.z>\n");
  process.exitCode = 2;
} else if (command === "set") {
  setVersion(version);
} else if (command === "check") {
  check(version);
} else if (command === "publish") {
  publish(version);
} else {
  process.stderr.write("Usage: node scripts/release.mjs <set|check|publish> <x.y.z>\n");
  process.exitCode = 2;
}
