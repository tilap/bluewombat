import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { featureWorkspacePath, pathSegment, subtaskWorkspacePath } from "./paths.js";

describe("pathSegment", () => {
  it("keeps a plain name as it is", () => {
    assert.equal(pathSegment("s1"), "s1");
    assert.equal(pathSegment("fake-42"), "fake-42");
  });

  it("turns a tracker key into a readable segment without URL escapes", () => {
    const segment = pathSegment("github:tilap/orangemonkey-site#1");
    assert.match(segment, /^github-tilap-orangemonkey-site-1-[0-9a-f]{8}$/);
    assert.doesNotMatch(segment, /[%:/#]/);
  });

  it("never gives two keys the same segment", () => {
    assert.notEqual(pathSegment("a:b"), pathSegment("a/b"));
    assert.notEqual(pathSegment("a b"), pathSegment("a-b"));
    assert.equal(pathSegment("a:b"), pathSegment("a:b"));
  });

  it("stays one safe segment whatever the input", () => {
    for (const raw of ["", ".", "..", "../x", "é ü", "a".repeat(300), "--", "%2F"]) {
      const segment = pathSegment(raw);
      assert.match(segment, /^[A-Za-z0-9][A-Za-z0-9._-]*$/, JSON.stringify(raw));
      assert.ok(segment.length <= 60, JSON.stringify(raw));
      assert.notEqual(segment, "..");
    }
  });
});

describe("workspace paths", () => {
  it("lay out <root>/<key>/feature and <root>/<key>/subtask-<id>", () => {
    assert.equal(featureWorkspacePath("/w", "fake:42"), `/w/${pathSegment("fake:42")}/feature`);
    assert.equal(
      subtaskWorkspacePath("/w", "fake:42", "A"),
      `/w/${pathSegment("fake:42")}/subtask-A`,
    );
    assert.doesNotMatch(subtaskWorkspacePath("/w", "github:o/r#1", "s 1"), /%/);
  });
});
