import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const srcRoot = dirname(fileURLToPath(import.meta.url));
const importFrom = /from\s+["']([^"']+)["']/g;

async function productionFiles(relativeDir: string): Promise<string[]> {
  const dir = join(srcRoot, relativeDir);
  const names = await readdir(dir, { recursive: true });
  return names
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => join(dir, name));
}

async function importSpecifiers(filePath: string): Promise<string[]> {
  const source = await readFile(filePath, "utf8");
  return [...source.matchAll(importFrom)].map((match) => match[1] ?? "");
}

describe("adapter isolation", () => {
  it("src/ledger production files import only the Persistence Port, not an adapter", async () => {
    const files = await productionFiles("ledger");
    assert.ok(files.length > 0);
    for (const filePath of files) {
      for (const specifier of await importSpecifiers(filePath)) {
        assert.equal(
          specifier.includes("persist-fs") ||
            specifier.includes("persist-sqlite") ||
            specifier.includes("node:fs") ||
            specifier.includes("node:sqlite"),
          false,
          `${filePath} imports ${specifier}`,
        );
      }
    }
  });

  it("src/persist holds only the Port", async () => {
    const names = await readdir(join(srcRoot, "persist"), { recursive: true });
    assert.deepEqual(
      names.filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts")).sort(),
      ["port.ts"],
    );
  });
});
