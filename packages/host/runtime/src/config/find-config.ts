import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { PRODUCT } from "@bluewombat/manager-kit";

export const CONFIG_FILENAME = `${PRODUCT}.config.yaml`;

/**
 * The nearest `mason.config.yaml`, walking up from `startDir`.
 *
 * Running from a subdirectory of the project is the common case, so the file is
 * looked up the way a toolchain config is, not demanded on the command line.
 */
export function findConfig(startDir: string): string | undefined {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, CONFIG_FILENAME);
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
