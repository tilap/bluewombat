import { copyFile, lstat, mkdir, readdir, readlink, rm, symlink } from "node:fs/promises";
import { platform } from "node:os";
import { basename, join, relative, sep } from "node:path";
import { type IsolationStop, IsolationStoppedError, throwIfStopped } from "@bluewombat/isolator";
import { runChild } from "./child/run-child.js";

/** How long one `cp` of one root entry may take before the walk takes over. */
const CLONE_TIMEOUT_MS = 120_000;

/**
 * What never leaves the Parent for a Child, unless a Project says otherwise:
 * a secret in the clear has no business in a workspace an agent reads and a
 * pull request may carry.
 */
export const DEFAULT_EXCLUDES: readonly string[] = [".env", ".env.*"];

/**
 * Copy working files from `from` into an existing `to` directory.
 * Skips `.git` only at the root of `from` when `skipGitAtRoot` is set, and
 * every path `exclude` names (see `isExcluded`).
 *
 * Each root entry is cloned by `cp` where the file system can — APFS, btrfs,
 * XFS: same bytes on disk, no second copy — and copied by hand where it
 * cannot. Excluded paths are then removed from the Child; a clone shares
 * blocks that were already on the disk, so nothing was written in the clear
 * that was not there before.
 */
export async function copyWorkingFiles(input: {
  from: string;
  to: string;
  skipGitAtRoot: boolean;
  exclude?: readonly string[];
  shouldStop: () => IsolationStop | undefined;
}): Promise<void> {
  const exclude = input.exclude ?? DEFAULT_EXCLUDES;
  await throwIfStopped(input.shouldStop);
  const entries = await readdir(input.from, { withFileTypes: true });
  for (const entry of entries) {
    await throwIfStopped(input.shouldStop);
    if (input.skipGitAtRoot && entry.name === ".git") {
      continue;
    }
    if (isExcluded(entry.name, exclude)) {
      continue;
    }
    const src = join(input.from, entry.name);
    const dest = join(input.to, entry.name);
    const cloned = await clone(src, dest, input.shouldStop);
    if (!cloned) {
      await rm(dest, { recursive: true, force: true });
      await copyEntry(src, dest, entry, input.shouldStop);
    }
  }
  await pruneExcluded(input.to, input.to, exclude, input.shouldStop);
}

export async function wipeWorkingFiles(
  directory: string,
  shouldStop: () => IsolationStop | undefined,
): Promise<void> {
  await throwIfStopped(shouldStop);
  const entries = await readdir(directory);
  for (const name of entries) {
    await throwIfStopped(shouldStop);
    if (name === ".git") {
      continue;
    }
    await rm(join(directory, name), { recursive: true, force: true });
  }
}

export { IsolationStoppedError };

/**
 * Whether `path` (relative to the copied root, `/`-separated) is one a
 * Project asked to leave behind.
 *
 * A pattern with no `/` is matched against the last segment, at any depth:
 * `.env` leaves out `.env` and `packages/api/.env`. A pattern with a `/` is
 * matched against the whole relative path from the root. `*` stands for any
 * run of characters within one segment, `**` for anything, `/` included; a
 * pattern opening with two stars and a slash means "at any depth", like a
 * bare name does.
 */
export function isExcluded(path: string, patterns: readonly string[]): boolean {
  const normalized = path.split(sep).join("/");
  return patterns.some((pattern) => {
    // A leading `**/` says "at any depth", which is what a bare name already means.
    const bare = pattern.startsWith("**/") ? pattern.slice(3) : pattern;
    const subject = bare.includes("/") ? normalized : basename(normalized);
    return toRegExp(bare).test(subject);
  });
}

function toRegExp(pattern: string): RegExp {
  const source = pattern
    .split("**")
    .map((part) =>
      part
        .split("*")
        .map((literal) => literal.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*"),
    )
    .join(".*");
  return new RegExp(`^${source}$`);
}

async function clone(
  src: string,
  dest: string,
  shouldStop: () => IsolationStop | undefined,
): Promise<boolean> {
  const flag = platform() === "darwin" ? "-c" : "--reflink=auto";
  const outcome = await runChild({
    argv: ["cp", "-R", "-P", flag, src, dest],
    timeoutMs: CLONE_TIMEOUT_MS,
    timeoutClock: "isolation",
    shouldInterrupt: () => shouldStop() === "interrupt",
  });
  if (outcome.kind === "interrupted") {
    throw new IsolationStoppedError("interrupt");
  }
  return outcome.kind === "exited" && outcome.exitCode === 0;
}

async function copyEntry(
  src: string,
  dest: string,
  entry: { isDirectory(): boolean; isSymbolicLink(): boolean; isFile(): boolean },
  shouldStop: () => IsolationStop | undefined,
): Promise<void> {
  await throwIfStopped(shouldStop);
  if (entry.isDirectory()) {
    await mkdir(dest);
    const entries = await readdir(src, { withFileTypes: true });
    for (const child of entries) {
      await copyEntry(join(src, child.name), join(dest, child.name), child, shouldStop);
    }
    return;
  }
  if (entry.isSymbolicLink()) {
    const target = await readlink(src);
    await symlink(target, dest);
    return;
  }
  if (entry.isFile()) {
    await copyFile(src, dest);
    return;
  }
  throw new Error(`Cannot isolate "${src}": unsupported file type.`);
}

/** Remove from `directory` every path below `root` that `patterns` name. Never follows a link. */
async function pruneExcluded(
  root: string,
  directory: string,
  patterns: readonly string[],
  shouldStop: () => IsolationStop | undefined,
): Promise<void> {
  if (patterns.length === 0) {
    return;
  }
  await throwIfStopped(shouldStop);
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (directory === root && entry.name === ".git") {
      continue;
    }
    if (isExcluded(relative(root, path), patterns)) {
      await rm(path, { recursive: true, force: true });
      continue;
    }
    if (entry.isDirectory() && !(await lstat(path)).isSymbolicLink()) {
      await pruneExcluded(root, path, patterns, shouldStop);
    }
  }
}
