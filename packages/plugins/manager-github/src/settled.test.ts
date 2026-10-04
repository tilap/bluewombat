import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { settledAlready } from "./settled.js";

describe("settledAlready", () => {
  it("skips an issue the tracker says is done or cancelled", () => {
    assert.equal(settledAlready({ labels: ["mason", "mason:done"] }, "mason:", "ready"), true);
    // A wiped ledger took up an abandoned issue again and started planning it.
    assert.equal(settledAlready({ labels: ["mason", "mason:cancelled"] }, "mason:", "ready"), true);
  });

  it("still delivers what is resumed, or not settled", () => {
    assert.equal(
      settledAlready({ labels: ["mason", "mason:cancelled", "ready"] }, "mason:", "ready"),
      false,
    );
    assert.equal(
      settledAlready({ labels: ["mason", "mason:escalated"] }, "mason:", "ready"),
      false,
    );
    assert.equal(settledAlready({ labels: ["mason", "ready"] }, "mason:", "ready"), false);
  });
});
