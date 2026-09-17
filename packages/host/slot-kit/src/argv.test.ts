import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BUILDER_FLAGS,
  GATE_FLAGS,
  ownArgv,
  PLANNER_FLAGS,
  splitRunner,
  stageOf,
  take,
} from "./argv.js";

/** argv as Node hands it over: the runtime, the script, then the tokens. */
function argv(...tokens: string[]): string[] {
  return ["/usr/bin/node", "/slots/gates/some.mjs", ...tokens];
}

describe("ownArgv", () => {
  it("keeps the slot's own tokens", () => {
    assert.deepEqual(ownArgv(argv("--remote", "upstream"), GATE_FLAGS), ["--remote", "upstream"]);
  });

  it("drops the caller's flags with their values", () => {
    const tokens = argv("--remote", "upstream", "--id", "t", "--attempt", "1", "--stage", "unit");
    assert.deepEqual(ownArgv(tokens, GATE_FLAGS), ["--remote", "upstream"]);
  });

  it("drops nothing when the flag belongs to another caller", () => {
    // `--report` is Implementer's to a Builder, and is not a Gate flag.
    assert.deepEqual(ownArgv(argv("--report", "boom"), GATE_FLAGS), ["--report", "boom"]);
    assert.deepEqual(ownArgv(argv("--report", "boom"), BUILDER_FLAGS), []);
  });

  it("keeps a trailing caller flag from swallowing a token that is not there", () => {
    assert.deepEqual(ownArgv(argv("--glob", "**/.env", "--stage"), GATE_FLAGS), [
      "--glob",
      "**/.env",
    ]);
  });

  it("reads the Planner's caller flags", () => {
    const tokens = argv("--read", "/project", "--key", "fake:1", "--max-units", "5");
    assert.deepEqual(ownArgv(tokens, PLANNER_FLAGS), ["--read", "/project"]);
  });

  it("skips the runtime and the script path", () => {
    assert.deepEqual(ownArgv(["node", "gate.mjs"], GATE_FLAGS), []);
  });
});

describe("splitRunner", () => {
  it("splits the slot's flags from the agent command after --", () => {
    const split = splitRunner(["--prompt-file", "p.md", "--", "node", "cursor.mjs", "--bin", "x"]);
    assert.deepEqual(split, {
      ok: true,
      own: ["--prompt-file", "p.md"],
      runner: ["node", "cursor.mjs", "--bin", "x"],
    });
  });

  it("is not ok when -- is missing, or when nothing follows it", () => {
    assert.deepEqual(splitRunner(["--prompt-file", "p.md"]), { ok: false });
    assert.deepEqual(splitRunner(["--prompt-file", "p.md", "--"]), { ok: false });
  });
});

describe("take", () => {
  it("reads the value after a flag", () => {
    assert.equal(take(argv("--intention", "Ship it"), "--intention"), "Ship it");
  });

  it("is undefined when the flag is absent", () => {
    assert.equal(take(argv("--attempt", "2"), "--intention"), undefined);
  });

  it("is undefined when the flag is last", () => {
    assert.equal(take(argv("--intention"), "--intention"), undefined);
  });
});

describe("stageOf", () => {
  it("is a unit when nothing says otherwise", () => {
    assert.equal(stageOf(argv()), "unit");
  });

  it("reads the stage Implementer named", () => {
    assert.equal(stageOf(argv("--stage", "assembly")), "assembly");
  });

  it("falls back to a unit when --stage carries no value", () => {
    assert.equal(stageOf(argv("--stage")), "unit");
  });
});
