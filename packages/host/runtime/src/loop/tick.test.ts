import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { HostRunInput } from "./context.js";
import { HEARTBEAT_MS, run } from "./tick.js";

/**
 * A loop of `passes` polls whose tracker answers `outcome`, on a clock that
 * moves `stepMs` per look, so a minute passes without waiting for it.
 */
async function loopOf(passes: number, stepMs: number, outcome = "completed") {
  const interruptFlag = { interrupted: false };
  const said: string[] = [];
  let polled = 0;
  const input = {
    options: {
      ledgerRoot: mkdtempSync(join(tmpdir(), "tick-")),
      pollIntervalMs: 1,
      interruptFlag,
    },
    features: {
      listen: async () => {
        polled += 1;
        if (polled >= passes) {
          interruptFlag.interrupted = true;
        }
        return { outcome, deliveries: [] };
      },
    },
    tickets: {},
    ledger: { listFeatures: async () => [], list: async () => [] },
    conductor: { pause: () => {} },
    journal: { append: () => {} },
    trace: (line: string) => said.push(line),
    watcher: {},
  } as unknown as HostRunInput;
  let clock = 0;
  await run(input, () => {
    clock += stepMs;
    return clock;
  });
  return said;
}

describe("a loop with nothing to do", () => {
  it("says once a minute that it is polling", async () => {
    const said = await loopOf(6, HEARTBEAT_MS / 2);
    const beats = said.filter((line) => line.startsWith("waiting"));
    assert.ok(beats.length >= 1, said.join("\n"));
    assert.match(beats[0] ?? "", /^waiting {4}nothing to do: \d+ poll\(s\) in \d+s$/);
  });

  it("stays quiet before the minute is up", async () => {
    const said = await loopOf(3, 1000);
    assert.deepEqual(said, []);
  });

  it("says every poll that the tracker could not be read", async () => {
    const said = await loopOf(2, 1000, "source-lost");
    assert.equal(
      said.filter((line) => /^listen {5}source-lost: the tracker could not be read$/.test(line))
        .length,
      2,
    );
  });
});
