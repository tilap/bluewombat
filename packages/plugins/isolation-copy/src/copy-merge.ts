import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  symlink,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { type FoldStop, IntegrationStoppedError, throwIfStopped } from "@bluewombat/integrator";

export type PathKind = "file" | "directory" | "symlink" | "missing";

export type CopyMergeResult =
  | { ok: true }
  | { ok: false; stop: FoldStop }
  | { ok: false; conflict: true; report: string }
  | { ok: false; detail: string };

/**
 * Directory merge of Child working files into Parent. Never forced.
 * Same-type bytes differences take the Child. Incompatible types are a conflict.
 */
export async function copyMerge(input: {
  parent: string;
  child: string;
  shouldStop: () => FoldStop | undefined;
}): Promise<CopyMergeResult> {
  try {
    const conflictPath = await findTypeConflict(
      input.parent,
      input.child,
      true,
      "",
      input.shouldStop,
    );
    if (conflictPath !== undefined) {
      return {
        ok: false,
        conflict: true,
        report: `Cannot fold without choosing a side: incompatible types at "${conflictPath}".`,
      };
    }
    await applyCopyMerge(input.parent, input.child, true, input.shouldStop);
    return { ok: true };
  } catch (error) {
    if (error instanceof IntegrationStoppedError) {
      return { ok: false, stop: error.stop };
    }
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, detail: `Integration could not complete: ${detail}` };
  }
}

function direntKind(entry: {
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

async function pathKind(path: string): Promise<PathKind | "other"> {
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

async function findTypeConflict(
  parentDir: string,
  childDir: string,
  isRoot: boolean,
  relativePrefix: string,
  shouldStop: () => FoldStop | undefined,
): Promise<string | undefined> {
  await throwIfStopped(shouldStop);
  const entries = await readdir(childDir, { withFileTypes: true });
  for (const entry of entries) {
    await throwIfStopped(shouldStop);
    if (isRoot && entry.name === ".git") {
      continue;
    }
    const relative = relativePrefix === "" ? entry.name : `${relativePrefix}/${entry.name}`;
    const parentPath = join(parentDir, entry.name);
    const childKind = direntKind(entry);
    if (childKind === "other") {
      throw new Error(`Cannot fold "${join(childDir, entry.name)}": unsupported file type.`);
    }
    const parentKind = await pathKind(parentPath);
    if (parentKind === "other") {
      throw new Error(`Cannot fold "${parentPath}": unsupported file type.`);
    }
    if (parentKind === "missing") {
      continue;
    }
    if (parentKind === "directory" && childKind === "directory") {
      const nested = await findTypeConflict(
        parentPath,
        join(childDir, entry.name),
        false,
        relative,
        shouldStop,
      );
      if (nested !== undefined) {
        return nested;
      }
      continue;
    }
    if (parentKind !== childKind) {
      return relative;
    }
  }
  return undefined;
}

async function applyCopyMerge(
  parentDir: string,
  childDir: string,
  isRoot: boolean,
  shouldStop: () => FoldStop | undefined,
): Promise<void> {
  await throwIfStopped(shouldStop);
  const entries = await readdir(childDir, { withFileTypes: true });
  for (const entry of entries) {
    await throwIfStopped(shouldStop);
    if (isRoot && entry.name === ".git") {
      continue;
    }
    const parentPath = join(parentDir, entry.name);
    const childPath = join(childDir, entry.name);
    const childKind = direntKind(entry);
    if (childKind === "other") {
      throw new Error(`Cannot fold "${childPath}": unsupported file type.`);
    }
    const parentKind = await pathKind(parentPath);
    if (parentKind === "other") {
      throw new Error(`Cannot fold "${parentPath}": unsupported file type.`);
    }

    if (parentKind === "missing") {
      if (childKind !== "missing") {
        await copyIncoming(childPath, parentPath, childKind, shouldStop);
      }
      continue;
    }

    if (parentKind === "directory" && childKind === "directory") {
      await applyCopyMerge(parentPath, childPath, false, shouldStop);
      continue;
    }

    if (parentKind === "file" && childKind === "file") {
      const parentBytes = await readFile(parentPath);
      const childBytes = await readFile(childPath);
      if (!parentBytes.equals(childBytes)) {
        await copyFile(childPath, parentPath);
      }
      continue;
    }

    if (parentKind === "symlink" && childKind === "symlink") {
      const parentTarget = await readlink(parentPath);
      const childTarget = await readlink(childPath);
      if (parentTarget !== childTarget) {
        await unlink(parentPath);
        await symlink(childTarget, parentPath);
      }
    }
  }
}

async function copyIncoming(
  childPath: string,
  parentPath: string,
  childKind: Exclude<PathKind, "missing">,
  shouldStop: () => FoldStop | undefined,
): Promise<void> {
  await throwIfStopped(shouldStop);
  if (childKind === "directory") {
    await mkdir(parentPath);
    await applyCopyMerge(parentPath, childPath, false, shouldStop);
    return;
  }
  if (childKind === "symlink") {
    const target = await readlink(childPath);
    await symlink(target, parentPath);
    return;
  }
  await copyFile(childPath, parentPath);
}
