import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { foldMessageOf, subjectOf } from "./open-conductor.js";

describe("subjectOf", () => {
  it("keeps a short sentence as is, without its full stop", () => {
    assert.equal(subjectOf("Add the slugify helper."), "Add the slugify helper");
  });

  it("takes the headline of text written like a commit, whatever follows it", () => {
    assert.equal(
      subjectOf(
        "Add titleCase in src/title-case.js\n\nIt capitalises every word. Its test sits beside it.",
      ),
      "Add titleCase in src/title-case.js",
    );
    // A paragraph wrapped by hand has no headline: the first sentence, as before.
    assert.equal(
      subjectOf("Add titleCase in\nsrc/title-case.js. Its test sits beside it."),
      "Add titleCase in src/title-case.js",
    );
  });

  it("takes the first sentence of a paragraph", () => {
    assert.equal(
      subjectOf("Add `src/truncate.js` exporting truncate. Add its test beside it. Document it."),
      "Add src/truncate.js exporting truncate",
    );
  });

  it("does not end a sentence on an abbreviation or a file name", () => {
    assert.equal(
      subjectOf(
        "Add a game module under src/ (e.g. guess-number.js) with tests. Keep npm test green.",
      ),
      "Add a game module under src/ (e.g. guess-number.js) with tests",
    );
    assert.equal(subjectOf("Document it in README.md. Nothing else."), "Document it in README.md");
  });

  it("cuts a long first sentence at a word, with no ellipsis and no backticks", () => {
    const long =
      "Add a plain ESM module `src/truncate.js` that exports `truncate(text, max)`: cut `text` to at most `max` characters and append an ellipsis when truncated";
    const subject = subjectOf(long);
    assert.ok(subject.length <= 72, subject);
    assert.doesNotMatch(subject, /[…`]/);
    assert.equal(subject, "Add a plain ESM module src/truncate.js that exports truncate(text");
  });
});

describe("foldMessageOf", () => {
  it("is the subject alone when that says it all", () => {
    assert.equal(foldMessageOf("Add the slugify helper."), "Add the slugify helper");
  });

  it("carries the whole text under the subject otherwise", () => {
    const text = "Add truncate. Add its test.";
    assert.equal(foldMessageOf(text), `Add truncate\n\n${text}`);
  });
});
