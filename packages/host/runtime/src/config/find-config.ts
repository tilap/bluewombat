import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_CONFIG_FILENAME } from "@bluewombat/manager-kit";

export { DEFAULT_CONFIG_FILENAME };

/**
 * The nearest config file, walking up from `startDir`.
 *
 * Running from a subdirectory of the project is the common case, so the file is
 * looked up the way a toolchain config is, not demanded on the command line.
 */
export function findConfig(startDir: string): string | undefined {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, DEFAULT_CONFIG_FILENAME);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}
