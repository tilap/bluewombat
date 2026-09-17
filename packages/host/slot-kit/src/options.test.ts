import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listOption, type OptionSpec, parseOptions, textOption } from "./options.js";

const SPEC: OptionSpec = {
  "--bin": {},
  "--model": {},
  "--output-format": { choices: ["json", "text"], fallback: "json" },
  "--agent-arg": { many: true },
  "--require-checks": { flag: true },
};

function parse(tokens: string[]) {
  return parseOptions(tokens, SPEC, "test slot");
}

describe("parseOptions", () => {
  it("keys a flag by its camel-case name", () => {
    const parsed = parse(["--output-format", "text"]);
    assert.ok(parsed.ok);
    assert.equal(parsed.values.outputFormat, "text");
  });

  it("applies a fallback the Project did not override", () => {
    const parsed = parse([]);
    assert.ok(parsed.ok);
    assert.equal(parsed.values.outputFormat, "json");
  });

  it("starts a repeatable flag as an empty list", () => {
    const parsed = parse([]);
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.values.agentArg, []);
  });

  it("collects every occurrence of a repeatable flag", () => {
    const parsed = parse(["--agent-arg", "--verbose", "--agent-arg", "--fast"]);
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.values.agentArg, ["--verbose", "--fast"]);
  });

  it("keeps the last value of a flag given twice", () => {
    const parsed = parse(["--model", "opus", "--model", "sonnet"]);
    assert.ok(parsed.ok);
    assert.equal(parsed.values.model, "sonnet");
  });

  it("reads a valueless flag as true, and leaves it out otherwise", () => {
    const on = parse(["--require-checks"]);
    assert.ok(on.ok);
    assert.equal(on.values.requireChecks, true);
    const off = parse([]);
    assert.ok(off.ok);
    assert.equal(off.values.requireChecks, undefined);
  });

  it("refuses a flag the spec does not have", () => {
    const parsed = parse(["--sandbox", "disabled"]);
    assert.ok(!parsed.ok);
    assert.equal(parsed.reason, 'The test slot does not take "--sandbox".');
  });

  it("refuses a flag with no value after it", () => {
    const parsed = parse(["--model"]);
    assert.ok(!parsed.ok);
    assert.equal(parsed.reason, "The test slot needs a value after --model.");
  });

  it("refuses a value outside the choices, and lists them", () => {
    const parsed = parse(["--output-format", "yaml"]);
    assert.ok(!parsed.ok);
    assert.equal(parsed.reason, '--output-format is json or text, not "yaml".');
  });

  it("lists three choices with commas and a final or", () => {
    const parsed = parseOptions(
      ["--mode", "nope"],
      { "--mode": { choices: ["a", "b", "c"] } },
      "test slot",
    );
    assert.ok(!parsed.ok);
    assert.equal(parsed.reason, '--mode is a, b or c, not "nope".');
  });

  it("takes a value that looks like a flag", () => {
    // `--agent-arg --verbose` is how an option is passed through to the CLI.
    const parsed = parse(["--agent-arg", "--verbose"]);
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.values.agentArg, ["--verbose"]);
  });
});

describe("textOption / listOption", () => {
  it("read a one-shot flag as text and a many flag as a list, nothing else", () => {
    const values = { model: "m", agentArg: ["a", "b"], verbose: true };
    assert.equal(textOption(values, "model"), "m");
    assert.equal(textOption(values, "agentArg"), undefined);
    assert.equal(textOption(values, "verbose"), undefined);
    assert.equal(textOption(values, "absent"), undefined);
    assert.deepEqual(listOption(values, "agentArg"), ["a", "b"]);
    assert.deepEqual(listOption(values, "model"), []);
  });
});
