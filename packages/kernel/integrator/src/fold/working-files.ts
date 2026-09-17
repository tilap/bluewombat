import { copyFile, lstat, mkdir, mkdtemp, readdir, readlink, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type FoldStop = "clock" | "interrupt";

export type PathKind = "file" | "directory" | "symlink" | "missing";

export class IntegrationStoppedError extends Error {
  readonly stop: FoldStop;

  constructor(stop: FoldStop) {
    super(
      stop === "clock"
        ? "The Integration clock fired."
        : "A stop signal arrived before Integration completed.",
    );
    this.name = "IntegrationStoppedError";
    this.stop = stop;
  }
}

export async function throwIfStopped(shouldStop: () => FoldStop | undefined): Promise<void> {
  const stop = shouldStop();
  if (stop !== undefined) {
    throw new IntegrationStoppedError(stop);
  }
}

export function direntKind(entry: {
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
  isFile(): boolean;
}): PathKind | "other" {
  if (entry.isSymbolicLink()) {
    return "symlink";
  }
  if (entry.isDirectory()) {
    return "directory";
  }
  if (entry.isFile()) {
    return "file";
  }
  return "other";
}

export async function pathKind(path: string): Promise<PathKind | "other"> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) {
      return "symlink";
    }
    if (stats.isDirectory()) {
      return "directory";
    }
    if (stats.isFile()) {
      return "file";
    }
    return "other";
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return "missing";
    }
    throw error;
  }
}

/**
 * Copy working files from `from` into an existing `to` directory.
 * Skips `.git` only at the root of `from` when `skipGitAtRoot` is set.
 */
export async function copyWorkingFiles(input: {
  from: string;
  to: string;
  skipGitAtRoot: boolean;
  shouldStop: () => FoldStop | undefined;
}): Promise<void> {
  await copyDir(input.from, input.to, true, input.skipGitAtRoot, input.shouldStop);
}

export async function wipeWorkingFiles(
  directory: string,
  shouldStop: () => FoldStop | undefined,
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

export async function snapshotWorkingFiles(directory: string): Promise<string> {
  const backup = await mkdtemp(join(tmpdir(), "integrator-parent-"));
  await copyWorkingFiles({
    from: directory,
    to: backup,
    skipGitAtRoot: true,
    shouldStop: () => undefined,
  });
  return backup;
}

export async function restoreWorkingFiles(directory: string, backup: string): Promise<void> {
  await wipeWorkingFiles(directory, () => undefined);
  await copyWorkingFiles({
    from: backup,
    to: directory,
    skipGitAtRoot: true,
    shouldStop: () => undefined,
  });
}

export async function removeSnapshot(backup: string): Promise<void> {
  await rm(backup, { recursive: true, force: true });
}

async function copyDir(
  from: string,
  to: string,
  isRoot: boolean,
  skipGitAtRoot: boolean,
  shouldStop: () => FoldStop | undefined,
): Promise<void> {
  await throwIfStopped(shouldStop);
  if (!isRoot) {
    await mkdir(to);
  }
  const entries = await readdir(from, { withFileTypes: true });
  for (const entry of entries) {
    await throwIfStopped(shouldStop);
    if (isRoot && skipGitAtRoot && entry.name === ".git") {
      continue;
    }
    const src = join(from, entry.name);
    const dest = join(to, entry.name);
    if (entry.isDirectory()) {
      await copyDir(src, dest, false, false, shouldStop);
      continue;
    }
    if (entry.isSymbolicLink()) {
      const target = await readlink(src);
      await symlink(target, dest);
      continue;
    }
    if (entry.isFile()) {
      await copyFile(src, dest);
      continue;
    }
    throw new Error(`Cannot fold "${src}": unsupported file type.`);
  }
}
