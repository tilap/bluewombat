import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadPlugin, type Shape } from "./load.js";

/** The simplest plugin there is: a module exporting a number called `answer`. */
const answerShape: Shape<number> = {
  kind: "Answer",
  check(loaded) {
    const answer = (loaded as { answer?: unknown } | null)?.answer;
    return typeof answer === "number"
      ? { ok: true, value: answer }
      : { ok: false, reason: "does not export answer" };
  },
};

function sandbox(): string {
  return mkdtempSync(join(tmpdir(), "plugin-"));
}

/** A package under `<root>/node_modules/<name>` whose entry is `exports`. */
function installed(root: string, name: string, body: string, manifest: Record<string, unknown>) {
  const dir = join(root, "node_modules", ...name.split("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, type: "module", ...manifest }));
  writeFileSync(join(dir, "index.js"), body);
}

describe("loadPlugin", () => {
  it("loads a file named relative to the config directory", async () => {
    const root = sandbox();
    writeFileSync(join(root, "answer.mjs"), "export const answer = 42;\n");
    const loaded = await loadPlugin("./answer.mjs", root, answerShape);
    assert.deepEqual(loaded, { ok: true, value: 42, specifier: "./answer.mjs" });
  });

  it("says when the file is not there", async () => {
    const root = sandbox();
    const loaded = await loadPlugin("./nowhere.mjs", root, answerShape);
    assert.ok(!loaded.ok);
    assert.match(loaded.reason, /^Answer "\.\/nowhere\.mjs" is not a file: /);
  });

  it("refuses a module of the wrong shape, in the shape's words", async () => {
    const root = sandbox();
    writeFileSync(join(root, "empty.mjs"), "export const nothing = 1;\n");
    const loaded = await loadPlugin("./empty.mjs", root, answerShape);
    assert.deepEqual(loaded, {
      ok: false,
      reason: 'Answer "./empty.mjs" does not export answer (./empty.mjs).',
    });
  });

  it("finds a bare name by walking node_modules up from the config directory", async () => {
    const root = sandbox();
    installed(root, "@acme/answer", "export const answer = 7;\n", {
      exports: { ".": { import: "./index.js" } },
    });
    const deep = join(root, "projects", "one");
    mkdirSync(deep, { recursive: true });
    const loaded = await loadPlugin("@acme/answer", deep, answerShape);
    assert.deepEqual(loaded, { ok: true, value: 7, specifier: "@acme/answer" });
  });

  it("reads main when a package declares no exports", async () => {
    const root = sandbox();
    installed(root, "plain-answer", "export const answer = 3;\n", { main: "index.js" });
    const loaded = await loadPlugin("plain-answer", root, answerShape);
    assert.ok(loaded.ok);
    assert.equal(loaded.value, 3);
  });

  it("says how to install a package that is nowhere", async () => {
    const root = sandbox();
    const loaded = await loadPlugin("@acme/answer-nowhere", root, answerShape);
    assert.ok(!loaded.ok);
    assert.match(
      loaded.reason,
      /^Answer "@acme\/answer-nowhere" could not be loaded\. Install it next to mason \(npm install @acme\/answer-nowhere\)\./,
    );
  });
});
