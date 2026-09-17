import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PRODUCT } from "@bluewombat/manager-kit";

/**
 * One `run` or `cancel` per ledger.
 *
 * Two processes on the same ledger both listen, both drive, and both report: the
 * tracker hears everything twice and the feature is folded by whichever got
 * there first. A lock file names the process that holds the ledger; a second
 * command refuses to start, unless that process is gone.
 */
export function lockPath(ledgerRoot: string): string {
  return join(ledgerRoot, "lock");
}

export async function acquireLock(ledgerRoot: string): Promise<() => Promise<void>> {
  await mkdir(ledgerRoot, { recursive: true });
  const path = lockPath(ledgerRoot);
  const mine = `${process.pid}\n`;
  for (;;) {
    try {
      await writeFile(path, mine, { flag: "wx" });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
    const holder = Number.parseInt((await readFile(path, "utf8")).trim(), 10);
    if (holder !== process.pid && isAlive(holder)) {
      throw new Error(
        `Another ${PRODUCT} run (pid ${holder}) holds ${ledgerRoot}. Stop it first, or point --home elsewhere.`,
      );
    }
    // Ours already, or left behind by a process that is gone.
    await rm(path, { force: true });
  }
  return async () => {
    try {
      if ((await readFile(path, "utf8")).trim() === String(process.pid)) {
        await rm(path, { force: true });
      }
    } catch {
      // Already gone.
    }
  };
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, and is not ours to signal. Still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
