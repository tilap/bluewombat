import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const srcRoot = dirname(fileURLToPath(import.meta.url));
const importFrom = /from\s+["']([^"']+)["']/g;

const forbidden = [
  "@bluewombat/isolator",
  "@bluewombat/implementer",
  "@bluewombat/integrator",
  "@bluewombat/feature-breakdown",
];

async function productionFiles(relativeDir: string): Promise<string[]> {
  const dir = join(srcRoot, relativeDir);
  const names = await readdir(dir, { recursive: true });
  return names
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => join(dir, name));
}

describe("transformer isolation", () => {
  it("src/run production files do not import Transformer packages", async () => {
    const files = await productionFiles("run");
    assert.ok(files.length > 0);
    for (const filePath of files) {
      const source = await readFile(filePath, "utf8");
      for (const specifier of [...source.matchAll(importFrom)].map((match) => match[1] ?? "")) {
        for (const name of forbidden) {
          assert.equal(specifier.includes(name), false, `${filePath} imports ${specifier}`);
        }
        assert.equal(specifier.includes("persist/fs"), false, `${filePath} imports ${specifier}`);
      }
    }
  });
});
