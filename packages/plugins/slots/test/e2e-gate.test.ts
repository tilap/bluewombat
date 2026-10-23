import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const node = process.execPath;
const gate = join(dirname(fileURLToPath(import.meta.url)), "../gates/e2e.mjs");

// A tiny application and a tiny suite, as the Project would supply them: the Gate is run as the
// program it is — argv in, one JSON verdict line out — against a real server on a real port.
const SERVER = `
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
const broken = (process.env.BREAK ?? "").split(",");
createServer((req, res) => {
  const id = req.url.split("/").pop();
  const bad = broken.includes(id);
  console.log("GET " + req.url + " -> " + (bad ? 500 : 200));
  res.statusCode = id === "health" ? 200 : bad ? 500 : 200;
  res.end("ok");
}).listen(Number(process.env.PORT), process.env.E2E_HOST, () => {
  writeFileSync("server-started", process.env.E2E_DATA_DIR);
});
`;

const READY = `
const r = await fetch("http://" + process.env.E2E_HOST + ":" + process.env.PORT + "/health").catch(() => undefined);
process.exit(r?.ok ? 0 : 1);
`;

// Tests named after their scenario id, one per entry of NAMES (default the manifest's ids).
const SUITE = `
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
const only = process.argv[2];
const names = (process.env.NAMES ?? "E1,E2,E3").split(",").filter((n) => !only || only.split("|").includes(n.split(" ")[0]));
const flaky = process.env.FLAKY;
const skipped = process.env.SKIP;
const cases = [];
for (const name of names) {
  const id = name.split(" ")[0];
  const res = await fetch("http://" + process.env.E2E_HOST + ":" + process.env.PORT + "/s/" + id);
  let failed = !res.ok;
  if (id === flaky && !existsSync("flaky-seen")) {
    writeFileSync("flaky-seen", "1");
    failed = true;
  }
  if (id === skipped) {
    cases.push('<testcase name="' + name + ' skipped" classname="e2e/app.spec.ts"><skipped/></testcase>');
  } else if (failed) {
    cases.push('<testcase name="' + name + ' page works" classname="e2e/app.spec.ts"><failure message="expected 200, got 500">Error: expected 200\\n    at e2e/app.spec.ts:12:5\\n[[ATTACHMENT|e2e/results/' + id + '/trace.zip]]</failure></testcase>');
  } else {
    cases.push('<testcase name="' + name + ' page works" classname="e2e/app.spec.ts"/>');
  }
}
mkdirSync(process.env.E2E_RESULTS_DIR, { recursive: true });
writeFileSync(process.env.E2E_RESULTS_DIR + "/junit.xml", '<testsuites><testsuite name="e2e">' + cases.join("") + "</testsuite></testsuites>");
process.exit(cases.some((c) => c.includes("<failure")) ? 1 : 0);
`;

const DOWN = `
import { writeFileSync } from "node:fs";
writeFileSync("down-ran", "1");
`;

async function freePort(): Promise<number> {
  return await new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

type Setup = {
  dir: string;
  port: number;
  args: string[];
  env: Record<string, string>;
};

async function setup(
  options: { ids?: string[]; env?: Record<string, string>; manifest?: unknown } = {},
): Promise<Setup> {
  const dir = mkdtempSync(join(tmpdir(), "e2e-gate-"));
  const port = await freePort();
  mkdirSync(join(dir, "e2e"), { recursive: true });
  writeFileSync(join(dir, "server.mjs"), SERVER);
  writeFileSync(join(dir, "ready.mjs"), READY);
  writeFileSync(join(dir, "suite.mjs"), SUITE);
  writeFileSync(join(dir, "down.mjs"), DOWN);
  writeFileSync(
    join(dir, "e2e", "scenarios.json"),
    JSON.stringify(options.manifest ?? options.ids ?? ["E1", "E2", "E3"]),
  );
  return {
    dir,
    port,
    args: [
      "--up",
      `${node} server.mjs`,
      "--ready",
      `${node} ready.mjs`,
      "--run",
      `${node} suite.mjs`,
      "--rerun",
      `${node} suite.mjs "{ids}"`,
      "--down",
      `${node} down.mjs`,
    ],
    env: { PORT: String(port), ...options.env },
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
      "e2e",
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

async function listening(port: number): Promise<boolean> {
  const res = await fetch(`http://127.0.0.1:${port}/health`).catch(() => undefined);
  return res?.ok === true;
}

describe("e2e gate", () => {
  it("passes when every scenario of the manifest ran green, and says which", async () => {
    const s = await setup();
    const result = await runGate(s);
    assert.equal(result.verdict, "pass");
    assert.match(result.report, /3 scenario\(s\)/);
    assert.match(result.report, /E1, E2, E3/);
    assert.doesNotMatch(result.report, /UNSTABLE/);
  });

  it("always stops the application, and removes the disposable data", async () => {
    const s = await setup();
    await runGate(s);
    assert.ok(existsSync(join(s.dir, "down-ran")), "--down ran");
    assert.equal(await listening(s.port), false, "the server is gone");
    assert.equal(existsSync(readFileSync(join(s.dir, "server-started"), "utf8")), false);
  });

  it("serves on the loopback address it was told and refuses any other", async () => {
    const s = await setup();
    const refused = await runGate(s, ["--host", "0.0.0.0"]);
    assert.equal(refused.verdict, "fail-blocking");
    assert.match(refused.report, /loopback/);
    assert.equal(existsSync(join(s.dir, "server-started")), false, "nothing was started");
  });

  it("hands every command the host, the port, a disposable data directory and the results directory", async () => {
    const s = await setup();
    s.args[s.args.indexOf("--run") + 1] =
      `${node} -e "require('fs').writeFileSync('seen-env', [process.env.E2E_HOST, process.env.E2E_PORT, process.env.E2E_DATA_DIR, process.env.E2E_RESULTS_DIR].join('|')); process.exit(0)"`;
    await runGate(s, ["--port", "4173"]);
    const [host, port, data, results] = readFileSync(join(s.dir, "seen-env"), "utf8").split("|");
    assert.equal(host, "127.0.0.1");
    assert.equal(port, "4173");
    assert.match(data ?? "", /e2e-data-/);
    assert.match(results ?? "", /\/e2e\/results$/);
  });

  it("is red with a short report when a scenario fails twice: scenario, step, message, log, trace", async () => {
    const s = await setup({ env: { BREAK: "E2" } });
    const result = await runGate(s);
    assert.equal(result.verdict, "fail-retryable");
    assert.match(result.report, /1 of 3 scenario\(s\) failed/);
    assert.match(result.report, /E2 — E2 page works/);
    assert.match(result.report, /at: at e2e\/app\.spec\.ts:12:5/);
    assert.match(result.report, /message: expected 200, got 500/);
    assert.match(result.report, /trace: e2e\/results\/E2\/trace\.zip/);
    assert.match(result.report, /GET \/s\/E2 -> 500/);
    assert.doesNotMatch(result.report, /E1 —/);
    assert.ok(existsSync(join(s.dir, "down-ran")));
  });

  it("retries only the failed scenario once, and flags one that passes then as unstable", async () => {
    const s = await setup({ env: { FLAKY: "E2" } });
    const result = await runGate(s);
    assert.equal(result.verdict, "pass");
    assert.match(result.report, /UNSTABLE: E2 passed only on the retry/);
  });

  it("runs the whole suite again when no --rerun is given", async () => {
    const s = await setup({ env: { FLAKY: "E3" } });
    s.args.splice(s.args.indexOf("--rerun"), 2);
    const result = await runGate(s);
    assert.equal(result.verdict, "pass");
    assert.match(result.report, /UNSTABLE: E3/);
  });

  it("fails a scenario of the manifest that no test ran", async () => {
    const s = await setup({ ids: ["E1", "E2", "E3", "E4"] });
    const result = await runGate(s);
    assert.equal(result.verdict, "fail-retryable");
    assert.match(result.report, /E4 — no test ran for it/);
  });

  it("fails a test that carries no scenario id of the manifest", async () => {
    const s = await setup({ ids: ["E1", "E2"], env: { NAMES: "E1,E2,X9" } });
    const result = await runGate(s);
    assert.equal(result.verdict, "fail-retryable");
    assert.match(result.report, /carry no scenario id/);
    assert.match(result.report, /X9 page works/);
  });

  it("does not take E1 for a test named E10", async () => {
    const s = await setup({ ids: ["E1", "E2"], env: { NAMES: "E10,E2" } });
    const result = await runGate(s);
    assert.equal(result.verdict, "fail-retryable");
    assert.match(result.report, /E1 — no test ran for it/);
  });

  it("does not take a skipped test for a pass", async () => {
    const s = await setup({ env: { SKIP: "E2" } });
    const result = await runGate(s);
    assert.equal(result.verdict, "fail-retryable");
    assert.match(result.report, /E2 — E2 skipped/);
    assert.match(result.report, /skipped scenario is not a passing one/);
  });

  it("is blocking when the application does not start, and still stops it", async () => {
    const s = await setup();
    s.args[s.args.indexOf("--up") + 1] =
      `${node} -e "console.error('boom: no port'); process.exit(3)"`;
    const result = await runGate(s);
    assert.equal(result.verdict, "fail-blocking");
    assert.match(result.report, /did not start/);
    assert.match(result.report, /exited with 3/);
    assert.match(result.report, /boom: no port/);
    assert.ok(existsSync(join(s.dir, "down-ran")));
  });

  it("is blocking when the application is never ready within the start timeout", async () => {
    const s = await setup();
    s.args[s.args.indexOf("--ready") + 1] = `${node} -e "process.exit(1)"`;
    const result = await runGate(s, ["--start-timeout-ms", "2500"]);
    assert.equal(result.verdict, "fail-blocking");
    assert.match(result.report, /not ready after/);
    assert.ok(existsSync(join(s.dir, "down-ran")));
  });

  it("is blocking, with the last output, when the suite outlives the run ceiling", async () => {
    const s = await setup();
    s.args[s.args.indexOf("--run") + 1] =
      `${node} -e "console.log('still going'); setTimeout(() => {}, 60000)"`;
    const result = await runGate(s, ["--max-run-ms", "4000"]);
    assert.equal(result.verdict, "fail-blocking");
    assert.match(result.report, /did not finish within/);
    assert.match(result.report, /still going/);
    assert.ok(existsSync(join(s.dir, "down-ran")));
  });

  it("is blocking when the manifest lists more scenarios than allowed", async () => {
    const s = await setup({ ids: ["E1", "E2", "E3", "E4", "E5", "E6"] });
    const result = await runGate(s);
    assert.equal(result.verdict, "fail-blocking");
    assert.match(result.report, /6 scenarios; at most 5/);
    assert.equal(existsSync(join(s.dir, "server-started")), false);
  });

  it("reads the manifest as objects with a title too, and the cap is an option", async () => {
    const s = await setup({
      manifest: { scenarios: [{ id: "E1", title: "home" }, { id: "E2" }] },
      env: { NAMES: "E1,E2" },
    });
    const result = await runGate(s, ["--max-scenarios", "2"]);
    assert.equal(result.verdict, "pass");
  });

  it("is blocking without a manifest", async () => {
    const s = await setup();
    const missing = await runGate(s, ["--manifest", "e2e/none.json"]);
    assert.equal(missing.verdict, "fail-blocking");
    assert.match(missing.report, /does not exist/);
  });

  it("is blocking when the suite writes no report and exits 0, red when it crashed", async () => {
    const quiet = await setup();
    quiet.args[quiet.args.indexOf("--run") + 1] = `${node} -e "process.exit(0)"`;
    const silent = await runGate(quiet);
    assert.equal(silent.verdict, "fail-blocking");
    assert.match(silent.report, /wrote no JUnit report/);

    const crash = await setup();
    crash.args[crash.args.indexOf("--run") + 1] =
      `${node} -e "console.error('SyntaxError in app'); process.exit(1)"`;
    const crashed = await runGate(crash);
    assert.equal(crashed.verdict, "fail-retryable");
    assert.match(crashed.report, /SyntaxError in app/);
  });

  it("ignores a report left by an earlier run", async () => {
    const s = await setup();
    mkdirSync(join(s.dir, "e2e", "results"), { recursive: true });
    writeFileSync(
      join(s.dir, "e2e", "results", "junit.xml"),
      '<testsuite><testcase name="E1 a"/><testcase name="E2 b"/><testcase name="E3 c"/></testsuite>',
    );
    s.args[s.args.indexOf("--run") + 1] = `${node} -e "process.exit(0)"`;
    const result = await runGate(s);
    assert.equal(result.verdict, "fail-blocking");
  });

  it("names the missing command, and takes nothing it does not know", async () => {
    const s = await setup();
    s.args.splice(s.args.indexOf("--down"), 2);
    const missing = await runGate(s);
    assert.equal(missing.verdict, "fail-blocking");
    assert.match(missing.report, /needs --down/);

    const odd = await runGate(await setup(), ["--bogus", "1"]);
    assert.equal(odd.verdict, "fail-blocking");
    assert.match(odd.report, /--bogus/);
  });
});
