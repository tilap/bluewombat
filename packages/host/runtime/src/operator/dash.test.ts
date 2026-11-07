import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { openFilesystemPersist } from "@bluewombat/persist-fs";
import { openWorkLedger } from "@bluewombat/work-ledger";
import { DEFAULT_CONFIG_FILENAME } from "../config/find-config.js";
import { fixtureYaml as stringifyYaml } from "../config/fixture-yaml.js";
import { openJournalFile } from "../loop/journal.js";
import { lockPath } from "../loop/lock.js";
import { runDash } from "./dash.js";
import type { Dash, DashRow } from "./dash-model.js";
import { age, renderDash } from "./dash-view.js";

function sandbox(): { cwd: string; ledgerRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "host-dash-"));
  mkdirSync(join(root, "stable"));
  const ledgerRoot = join(root, "ledger");
  mkdirSync(ledgerRoot);
  const tracker = {
    package: "@bluewombat/manager-fake",
    options: { source: "./source", target: "./threads" },
  };
  writeFileSync(
    join(root, DEFAULT_CONFIG_FILENAME),
    stringifyYaml({
      featureTracker: tracker,
      ticketTracker: tracker,
      workLine: { stable: "./stable", isolation: "@bluewombat/isolation-copy" },
      workspaceRoot: "./workspaces",
      ledger: "./ledger",
      builder: {
        producer: { cmd: [process.execPath, "-e", ""], timeoutMs: 1000 },
        repair: { cmd: [process.execPath, "-e", ""], timeoutMs: 1000 },
        gates: { gates: [{ id: "check", argv: [process.execPath, "-e", ""], timeoutMs: 1000 }] },
      },
      timeoutMs: 1000,
    }),
  );
  return { cwd: root, ledgerRoot };
}

const ESC = "\x1b[";

const row = (over: Partial<DashRow>): DashRow => ({
  kind: "ticket",
  key: "t#1",
  state: "running",
  detail: "",
  priority: 1,
  waitingOn: [],
  ...over,
});

const dash = (over: Partial<Dash>): Dash => ({
  now: 1_000_000,
  install: { version: "1.2.3", source: "npm", dir: "/x/node_modules/@bluewombat/runtime" },
  worker: { running: true, pid: 42, since: 1_000_000 - 3_600_000, version: "1.2.3" },
  active: [],
  upcoming: [],
  past: [],
  ...over,
});

describe("renderDash", () => {
  it("says the version and that it is the npm package", () => {
    const text = renderDash(dash({}), { width: 100, height: 30, color: false }).join("\n");
    assert.match(text, /mason 1\.2\.3 · npm package/);
  });

  it("says a linked checkout is a local copy", () => {
    const text = renderDash(
      dash({ install: { version: "1.2.3", source: "local", dir: "/work/runtime" } }),
      { width: 100, height: 30, color: false },
    ).join("\n");
    assert.match(text, /local copy \/work\/runtime/);
  });

  it("says the worker runs and since when, or that it stopped, or that it died", () => {
    const style = { width: 100, height: 30, color: false };
    assert.match(renderDash(dash({}), style).join("\n"), /running {2}pid 42 · up 1h00/);
    const stopped = dash({
      worker: { running: false, ended: "clean", at: 1_000_000 - 120_000, version: "1.2.3" },
    });
    assert.match(renderDash(stopped, style).join("\n"), /stopped.*stopped 2m ago/);
    const died = dash({
      worker: { running: false, ended: "killed", at: 1_000_000 - 5_000, version: "1.2.3" },
    });
    assert.match(renderDash(died, style).join("\n"), /died without saying so/);
  });

  it("warns when the worker runs another version than this command", () => {
    const text = renderDash(
      dash({ worker: { running: true, pid: 1, since: undefined, version: "0.9.0" } }),
      { width: 120, height: 30, color: false },
    ).join("\n");
    assert.match(text, /the worker runs 0\.9\.0, this command 1\.2\.3/);
  });

  it("lists the three zones with an icon per state, and what a row waits on", () => {
    const text = renderDash(
      dash({
        active: [row({ key: "t#2", state: "escalated", detail: "unit — waiting for a human" })],
        upcoming: [row({ key: "t#3", state: "received", waitingOn: ["t#2"] })],
        past: [row({ key: "t#1", state: "done", last: { at: 1_000_000 - 90_000, what: "done" } })],
      }),
      { width: 120, height: 30, color: false },
    ).join("\n");
    assert.match(text, /ACTIVE \(1\)\n🛑 2 {2}escalated +unit — waiting for a human/);
    assert.match(text, /UPCOMING \(1\)\n⏳ 3 {2}received.*⛓ 2/);
    assert.match(text, /PAST \(1\)\n✅ 1 {2}done.*· done 1m/);
  });

  it("paints only when asked", () => {
    const frame = dash({ active: [row({ state: "escalated" })] });
    const plain = renderDash(frame, { width: 100, height: 30, color: false }).join("");
    const painted = renderDash(frame, { width: 100, height: 30, color: true }).join("");
    assert.ok(!plain.includes(ESC));
    assert.ok(painted.includes(`${ESC}31m`), "an escalated row is red");
  });

  it("fits the terminal: a long list is cut with a count, never past the width", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      row({ key: `t#${i}`, state: "done", title: "x".repeat(200) }),
    );
    const lines = renderDash(dash({ past: many }), { width: 60, height: 16, color: false });
    assert.ok(lines.length <= 16, `${lines.length} lines`);
    assert.ok(lines.some((l) => /\+\d+ more/.test(l)));
    for (const line of lines) {
      // Each emoji is one code point of two columns.
      assert.ok([...line].length <= 60, line);
    }
  });
});

describe("age", () => {
  it("is short", () => {
    assert.equal(age(4_000), "4s");
    assert.equal(age(125_000), "2m");
    assert.equal(age(3_900_000), "1h05");
    assert.equal(age(3 * 86_400_000), "3d");
  });
});

describe("runDash", () => {
  it("prints one frame, without escape codes, when stdout is not a terminal", async () => {
    const { cwd, ledgerRoot } = sandbox();
    const ledger = openWorkLedger({ persist: await openFilesystemPersist({ root: ledgerRoot }) });
    await ledger.admit({
      key: "fake:1",
      project: "app",
      fingerprint: "a",
      priority: 1,
      intention: "first",
      title: "First thing",
    });
    await ledger.admit({
      key: "fake:2",
      project: "app",
      fingerprint: "b",
      priority: 1,
      intention: "second",
      title: "Second thing",
      blocked_by: ["fake:1"],
    });
    await ledger.claim("app");
    const out: string[] = [];
    const code = await runDash({
      cwd,
      argv: [],
      write: (text) => out.push(text),
      interruptFlag: { interrupted: false },
    });
    const text = out.join("");
    assert.equal(code, 0);
    assert.ok(!text.includes(ESC), "no escape codes in a pipe");
    assert.match(text, /mason \d/);
    assert.match(text, /stopped.*no run recorded/);
    assert.match(text, /ACTIVE \(1\)\n🔨 1 {2}running.*First thing/);
    assert.match(text, /UPCOMING \(1\)\n⏳ 2 {2}received.*Second thing.*⛓ 1/);
  });

  it("sees a worker through its lock, and a finished Ticket through the journal", async () => {
    const { cwd, ledgerRoot } = sandbox();
    const ledger = openWorkLedger({ persist: await openFilesystemPersist({ root: ledgerRoot }) });
    await ledger.admit({
      key: "fake:9",
      project: "app",
      fingerprint: "z",
      priority: 1,
      intention: "old",
    });
    await ledger.cancel("fake:9");
    writeFileSync(lockPath(ledgerRoot), `${process.pid}\n`);
    const journal = openJournalFile(ledgerRoot);
    journal.append({ event: "host-started", pid: process.pid, version: "7.7.7" });
    journal.append({ event: "cancelled", key: "fake:9" });
    const out: string[] = [];
    await runDash({
      cwd,
      argv: [],
      write: (text) => out.push(text),
      interruptFlag: { interrupted: false },
    });
    const text = out.join("");
    assert.match(text, new RegExp(`running {2}pid ${process.pid}`));
    assert.match(text, /the worker runs 7\.7\.7/);
    assert.match(text, /PAST \(1\)\n🚫 9 {2}cancelled.*· cancelled \d+s/);
  });

  it("redraws in place at a terminal until interrupted, and gives the screen back", async () => {
    const { cwd } = sandbox();
    const interruptFlag = { interrupted: false };
    const out: string[] = [];
    let frames = 0;
    const code = await runDash({
      cwd,
      argv: ["--interval-ms", "200"],
      write: (text) => {
        out.push(text);
        if (text.startsWith("\x1b[H") && ++frames === 2) {
          interruptFlag.interrupted = true;
        }
      },
      interruptFlag,
      screen: { columns: 80, rows: 24, color: false, size: () => ({ columns: 80, rows: 24 }) },
    });
    assert.equal(code, 0);
    assert.equal(out[0], "\x1b[?1049h\x1b[?25l");
    assert.equal(out.at(-1), "\x1b[?25h\x1b[?1049l");
    assert.equal(frames, 2);
  });

  it("refuses a bad interval", async () => {
    const out: string[] = [];
    const code = await runDash({
      cwd: tmpdir(),
      argv: ["--interval-ms", "5"],
      write: (text) => out.push(text),
      interruptFlag: { interrupted: false },
    });
    assert.equal(code, 2);
    assert.match(out.join(""), /--interval-ms/);
  });
});

describe("tree view", () => {
  const style = { width: 100, height: 30, color: false, mode: "tree" as const };

  it("hangs a row under what it waits on, and names its other blockers", () => {
    const text = renderDash(
      dash({
        active: [row({ key: "t#2", state: "escalated" })],
        upcoming: [
          row({ key: "t#3", state: "received", waitingOn: ["t#2"] }),
          row({ key: "t#4", state: "received", waitingOn: ["t#3"] }),
          row({ key: "t#5", state: "received", waitingOn: ["t#2", "t#9"] }),
          row({ key: "t#6", state: "received" }),
        ],
        past: [row({ key: "t#1", state: "done" })],
      }),
      style,
    ).join("\n");
    assert.match(text, /TO DO \(5\) {2}· {2}1 over/);
    assert.match(text, /🛑 2 .*escalated\n├─ ⏳ 3 .*received\n│ {2}└─ ⏳ 4 /);
    assert.match(text, /└─ ⏳ 5 .*⛓ 9/);
    assert.match(text, /\n⏳ 6 /);
  });

  it("does not loop on a cycle", () => {
    const lines = renderDash(
      dash({
        upcoming: [
          row({ key: "t#1", state: "received", waitingOn: ["t#2"] }),
          row({ key: "t#2", state: "received", waitingOn: ["t#1"] }),
        ],
      }),
      style,
    );
    assert.equal(lines.filter((l) => /t#|⏳/.test(l)).length, 2);
  });

  it("opens on the tree with --tree, and t flips it at a terminal", async () => {
    const { cwd } = sandbox();
    const interruptFlag = { interrupted: false };
    const out: string[] = [];
    let press: (key: string) => void = () => {};
    let frames = 0;
    await runDash({
      cwd,
      argv: ["--tree", "--interval-ms", "200"],
      write: (text) => {
        out.push(text);
        if (text.startsWith("\x1b[H")) {
          frames += 1;
          if (frames === 1) {
            press("t");
          } else {
            press("q");
          }
        }
      },
      interruptFlag,
      keys: {
        subscribe: (onKey) => {
          press = onKey;
          return () => {};
        },
      },
      screen: { columns: 80, rows: 24, color: false, size: () => ({ columns: 80, rows: 24 }) },
    });
    const frame = out.filter((t) => t.startsWith("\x1b[H"));
    assert.equal(frame.length, 2);
    assert.match(frame[0] ?? "", /TO DO/);
    assert.match(frame[1] ?? "", /ACTIVE/);
    assert.match(frame[1] ?? "", /t list\/tree · r redraw · q quit/);
    assert.equal(interruptFlag.interrupted, true);
  });
});
