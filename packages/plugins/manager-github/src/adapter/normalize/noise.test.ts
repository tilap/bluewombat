import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripTrackerNoise } from "./noise.js";

describe("stripTrackerNoise", () => {
  it("drops the comments an issue template leaves behind", () => {
    const body = "<!-- Describe the bug -->\nThe export is empty.\n<!--\nsteps\n-->";
    assert.equal(stripTrackerNoise(body), "The export is empty.");
  });

  it("takes the box off a task-list item and keeps the bullet and the words", () => {
    const body = [
      "Users need a CSV export.",
      "",
      "- [ ] A CSV downloads",
      "* [x] It has a header",
      "1. [X] Done",
    ].join("\n");
    assert.equal(
      stripTrackerNoise(body),
      ["Users need a CSV export.", "", "- A CSV downloads", "* It has a header", "1. Done"].join(
        "\n",
      ),
    );
  });

  it("reads the same whether a box is ticked or not", () => {
    const unticked = "Ship it.\n\n- [ ] one\n- [ ] two";
    const ticked = "Ship it.\n\n- [x] one\n- [ ] two";
    assert.equal(stripTrackerNoise(ticked), stripTrackerNoise(unticked));
  });

  it("keeps a nested item's indentation and a box that is not at the start of the item", () => {
    const body = "- outer\n  - [ ] inner\n- see [x] in the text";
    assert.equal(stripTrackerNoise(body), "- outer\n  - inner\n- see [x] in the text");
  });

  it("drops an empty box, normalises line ends and blank runs, and trims", () => {
    const body = "  Title line  \r\n\r\n\r\n\r\n- [ ]\r\n- [ ] kept\r\n\r\n";
    assert.equal(stripTrackerNoise(body), "Title line\n\n- kept");
  });

  it("leaves a body with no noise exactly as written", () => {
    const body =
      'Add snakeCase in src/snake-case.js.\n\n`snakeCase("Hello World")` returns `"hello_world"`.';
    assert.equal(stripTrackerNoise(body), body);
  });

  it("returns nothing for a body that was only noise", () => {
    assert.equal(stripTrackerNoise("<!-- fill me -->\n- [ ]\n"), "");
  });
});
