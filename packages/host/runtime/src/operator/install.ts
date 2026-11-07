import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hostVersion } from "../loop/open-host.js";

/** Which copy of Host is answering: the published package, or a checkout it was linked from. */
export type Install = {
  version: string;
  /** `npm` when it sits under a `node_modules`; `local` for a linked checkout or a build run in place. */
  source: "npm" | "local";
  dir: string;
};

export function installOf(): Install {
  const here = realpathSync(dirname(fileURLToPath(import.meta.url)));
  return {
    version: hostVersion(),
    source: here.split(/[\\/]/).includes("node_modules") ? "npm" : "local",
    // `<package>/dist/operator` or `<package>/src/operator`: two levels up is the package.
    dir: dirname(dirname(here)),
  };
}
