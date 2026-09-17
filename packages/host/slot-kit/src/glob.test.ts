import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pathMatchesGlob } from "./glob.js";

describe("pathMatchesGlob", () => {
  it("matches a literal path", () => {
    assert.equal(pathMatchesGlob(".env", ".env"), true);
    assert.equal(pathMatchesGlob(".env.local", ".env"), false);
  });

  it("holds * to one segment", () => {
    assert.equal(pathMatchesGlob("src/index.ts", "src/*.ts"), true);
    assert.equal(pathMatchesGlob("src/deep/index.ts", "src/*.ts"), false);
  });

  it("lets **/ stand for any depth, including none", () => {
    assert.equal(pathMatchesGlob(".env", "**/.env"), true);
    assert.equal(pathMatchesGlob("apps/web/.env", "**/.env"), true);
    assert.equal(pathMatchesGlob("apps/web/.env.local", "**/.env"), false);
  });

  it("lets a trailing ** stand for the rest of the path", () => {
    assert.equal(pathMatchesGlob("secrets/a/b/c.pem", "secrets/**"), true);
    assert.equal(pathMatchesGlob("secrets", "secrets/**"), false);
  });

  it("holds ? to one character in one segment", () => {
    assert.equal(pathMatchesGlob("a1.txt", "a?.txt"), true);
    assert.equal(pathMatchesGlob("a/1.txt", "a?1.txt"), false);
  });

  it("reads a Windows path as a posix one", () => {
    assert.equal(pathMatchesGlob("apps\\web\\.env", "**/.env"), true);
  });

  it("takes a regex character in the pattern literally", () => {
    assert.equal(pathMatchesGlob("a.env", "*.env"), true);
    assert.equal(pathMatchesGlob("aXenv", "*.env"), false);
    assert.equal(pathMatchesGlob("config(1).json", "config(1).json"), true);
  });

  it("anchors both ends", () => {
    assert.equal(pathMatchesGlob("src/index.ts", "index.ts"), false);
    assert.equal(pathMatchesGlob("index.ts.bak", "index.ts"), false);
  });
});
