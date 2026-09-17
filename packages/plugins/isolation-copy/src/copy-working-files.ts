import { copyFile, mkdir, readdir, readlink, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { type IsolationStop, IsolationStoppedError, throwIfStopped } from "@bluewombat/isolator";

/**
 * Copy working files from `from` into an existing `to` directory.
 * Skips `.git` only at the root of `from` when `skipGitAtRoot` is set.
 */
export async function copyWorkingFiles(input: {
  from: string;
  to: string;
  skipGitAtRoot: boolean;
  shouldStop: () => IsolationStop | undefined;
}): Promise<void> {
  await copyDir(input.from, input.to, true, input.skipGitAtRoot, input.shouldStop);
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

async function copyDir(
  from: string,
  to: string,
  isRoot: boolean,
  skipGitAtRoot: boolean,
  shouldStop: () => IsolationStop | undefined,
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
    throw new Error(`Cannot isolate "${src}": unsupported file type.`);
  }
}
