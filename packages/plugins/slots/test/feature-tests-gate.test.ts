import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const node = process.execPath;
const gate = join(dirname(fileURLToPath(import.meta.url)), "../gates/feature-tests.mjs");

// A tiny test runner, as the Project would supply one: it takes the ids to run and the report path,
// and writes a JUnit report. The Gate is run as the program it is: argv in, one JSON verdict line out.
const SUITE = `
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
const [only, junit] = process.argv.slice(2);
const ids = only.split("|");
const broken = (process.env.BREAK ?? "").split(",");
const skipped = process.env.SKIP;
const names = (process.env.NAMES ?? ids.join(",")).split(",");
const cases = [];
for (const name of names) {
  const id = name.split(" ")[0];
  if (!ids.includes(id) && !process.env.NAMES) continue;
  if (id === skipped) {
    cases.push('<testcase name="' + name + ' skipped" classname="app.test.ts"><skipped/></testcase>');
  } else if (broken.includes(id)) {
    cases.push('<testcase name="' + name + ' works" classname="app.test.ts"><failure message="expected 200, got 500">Error: expected 200\\n    at app.test.ts:12:5</failure></testcase>');
  } else {
    cases.push('<testcase name="' + name + ' works" classname="app.test.ts"/>');
  }
}
mkdirSync(dirname(junit), { recursive: true });
writeFileSync(junit, '<testsuites><testsuite name="feature">' + cases.join("") + "</testsuite></testsuites>");
process.exit(cases.some((c) => c.includes("<failure")) ? 1 : 0);
`;

type Setup = { dir: string; args: string[]; env: Record<string, string> };

function setup(
  options: { ids?: string[]; env?: Record<string, string>; manifest?: unknown } = {},
): Setup {
  const dir = mkdtempSync(join(tmpdir(), "feature-tests-gate-"));
  mkdirSync(join(dir, "feature-tests"), { recursive: true });
  writeFileSync(join(dir, "suite.mjs"), SUITE);
  writeFileSync(
    join(dir, "feature-tests", "scenarios.json"),
    JSON.stringify(options.manifest ?? options.ids ?? ["S1", "S2", "S3"]),
  );
  return {
    dir,
    args: ["--run", `${node} suite.mjs "{ids}" "{junit}"`],
    env: { ...options.env },
  };
}

type Verdict = { verdict: string; report: string };

async function runGate(s: Setup, extra: string[] = []): Promise<Verdict> {
  const child = spawn(
    node,
    [
      gate,
      ...s.args,
      ...extra,
      "--id",
      "F1:judgement",
      "--attempt",
      "1",
      "--gate-id",
      "feature-tests",
      "--intention",
      "the feature",
      "--timeout-ms",
      "120000",
      "--stage",
      "feature",
    ],
    { cwd: s.dir, env: { ...process.env, ...s.env } },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  await new Promise((resolve) => child.on("close", resolve));
  const last = stdout
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .at(-1);
  assert.ok(last !== undefined, `stdout: ${stdout} stderr: ${stderr}`);
  return JSON.parse(last) as Verdict;
}

describe("feature-tests gate", () => {
  it("passes when every scenario of the manifest ran green, and says which", () =>
    (async () => {
      const result = await runGate(setup());
      assert.equal(result.verdict, "pass");
      assert.match(result.report, /3 scenario\(s\)/);
      assert.match(result.report, /S1, S2, S3/);
    })());

  it("hands --run the ids of the manifest and the report path", async () => {
    const s = setup({ ids: ["S4", "S7"] });
    s.args[1] = `${node} -e "require('fs').writeFileSync('seen', process.argv.slice(1).join(' '))" "{ids}" "{junit}"`;
    await runGate(s);
    const seen = (await import("node:fs")).readFileSync(join(s.dir, "seen"), "utf8");
    assert.match(seen, /S4\|S7 .*feature-tests\/results\/junit\.xml$/);
  });

  it("runs only the scenarios of the manifest, and says so when the runner runs others", async () => {
    const s = setup({ ids: ["S1", "S2"], env: { NAMES: "S1,S2,X9" } });
    const result = await runGate(s);
    assert.equal(result.verdict, "fail-retryable");
    assert.match(result.report, /carry no scenario id/);
    assert.match(result.report, /X9 works/);
  });

  it("is red with a short report when a scenario fails: scenario, step, message", async () => {
    const result = await runGate(setup({ env: { BREAK: "S2" } }));
    assert.equal(result.verdict, "fail-retryable");
    assert.match(result.report, /1 of 3 scenario\(s\) failed/);
    assert.match(result.report, /S2 — S2 works/);
    assert.match(result.report, /at: at app\.test\.ts:12:5/);
    assert.match(result.report, /message: expected 200, got 500/);
    assert.doesNotMatch(result.report, /S1 —/);
  });

  it("fails a scenario of the manifest that no test ran", async () => {
    const s = setup({ ids: ["S1", "S2", "S3", "S4"], env: { NAMES: "S1,S2,S3" } });
    const result = await runGate(s);
    assert.equal(result.verdict, "fail-retryable");
    assert.match(result.report, /S4 — no test ran for it/);
  });

  it("does not take S1 for a test named S10", async () => {
    const s = setup({ ids: ["S1", "S2"], env: { NAMES: "S10,S2" } });
    const result = await runGate(s);
    assert.equal(result.verdict, "fail-retryable");
    assert.match(result.report, /S1 — no test ran for it/);
  });

  it("does not take a skipped test for a pass", async () => {
    const result = await runGate(setup({ env: { SKIP: "S2" } }));
    assert.equal(result.verdict, "fail-retryable");
    assert.match(result.report, /S2 — S2 skipped/);
    assert.match(result.report, /skipped scenario is not a passing one/);
  });

  it("holds any number of scenarios", async () => {
    const ids = ["S1", "S2", "S3", "S4", "S5", "S6", "S7"];
    const result = await runGate(setup({ ids }));
    assert.equal(result.verdict, "pass");
  });

  it("reads the manifest as objects with a title too", async () => {
    const s = setup({ manifest: { scenarios: [{ id: "S1", title: "home" }, { id: "S2" }] } });
    const result = await runGate(s);
    assert.equal(result.verdict, "pass");
  });

  it("is blocking without a manifest, or with an empty one", async () => {
    const missing = await runGate(setup(), ["--manifest", "feature-tests/none.json"]);
    assert.equal(missing.verdict, "fail-blocking");
    assert.match(missing.report, /does not exist/);

    const empty = await runGate(setup({ ids: [] }));
    assert.equal(empty.verdict, "fail-blocking");
    assert.match(empty.report, /lists no scenario/);
  });

  it("is blocking, with the last output, when the run outlives the ceiling", async () => {
    const s = setup();
    s.args[1] = `${node} -e "console.log('still going'); setTimeout(() => {}, 60000)"`;
    const result = await runGate(s, ["--max-run-ms", "2000"]);
    assert.equal(result.verdict, "fail-blocking");
    assert.match(result.report, /did not finish within/);
    assert.match(result.report, /still going/);
  });

  it("is blocking when the run writes no report and exits 0, red when it crashed", async () => {
    const quiet = setup();
    quiet.args[1] = `${node} -e "process.exit(0)"`;
    const silent = await runGate(quiet);
    assert.equal(silent.verdict, "fail-blocking");
    assert.match(silent.report, /wrote no JUnit report/);

    const crash = setup();
    crash.args[1] = `${node} -e "console.error('SyntaxError in app'); process.exit(1)"`;
    const crashed = await runGate(crash);
    assert.equal(crashed.verdict, "fail-retryable");
    assert.match(crashed.report, /SyntaxError in app/);
  });

  it("ignores a report left by an earlier run", async () => {
    const s = setup();
    mkdirSync(join(s.dir, "feature-tests", "results"), { recursive: true });
    writeFileSync(
      join(s.dir, "feature-tests", "results", "junit.xml"),
      '<testsuite><testcase name="S1 a"/><testcase name="S2 b"/><testcase name="S3 c"/></testsuite>',
    );
    s.args[1] = `${node} -e "process.exit(0)"`;
    const result = await runGate(s);
    assert.equal(result.verdict, "fail-blocking");
    assert.equal(existsSync(join(s.dir, "feature-tests", "results", "junit.xml")), false);
  });

  it("names the missing command, and takes nothing it does not know", async () => {
    const s = setup();
    s.args = [];
    const missing = await runGate(s);
    assert.equal(missing.verdict, "fail-blocking");
    assert.match(missing.report, /needs --run/);

    const odd = await runGate(setup(), ["--bogus", "1"]);
    assert.equal(odd.verdict, "fail-blocking");
    assert.match(odd.report, /--bogus/);
  });
});
