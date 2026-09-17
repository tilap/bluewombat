import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const srcRoot = dirname(fileURLToPath(import.meta.url));
const importFrom = /from\s+["']([^"']+)["']/g;

describe("live view isolation", () => {
  it("does not import openHost or a manager package", async () => {
    const source = await readFile(join(srcRoot, "live.ts"), "utf8");
    const specifiers = [...source.matchAll(importFrom)].map((match) => match[1] ?? "");
    for (const specifier of specifiers) {
      assert.equal(
        specifier.includes("open-host") || specifier.includes("manager-"),
        false,
        `live.ts imports ${specifier}`,
      );
    }
  });
});
