#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { emitVerdict, GATE_FLAGS, ownArgv } from "@bluewombat/slot-kit";

// The work line's own checks, on the work this workspace published.
//
// It reads and nothing else: it does not push, does not open anything, does not
// merge. Whoever put the work in front of the checks did that before this Gate
// ran; this Gate only says whether the answer came back green.
//
//   --remote NAME        default: origin
//   --poll-ms N          how often to ask again while checks are running
//   --token-env NAME     required: the variable holding a token that can read
//                        the checks. No default on purpose — GITHUB_TOKEN is the
//                        one name `gh` reads ahead of its own login, so an
//                        operator must not export it, and a Gate that fell back
//                        to it failed only at the first assembly of a real run
//   --require-checks     wait for a check to appear; without it, a commit with no
//                        check at all passes

const API = "https://api.github.com";
// What the runner writes at the top of every step it runs.
const STEP_OPEN = "##[group]Run ";
const COLOUR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

const cwd = process.cwd();
const options = parseOwnArgv(ownArgv(process.argv, GATE_FLAGS));
if (!options.ok) {
  emitVerdict("fail-blocking", options.reason);
  process.exit(0);
}

if (git(["rev-parse", "--is-inside-work-tree"]).stdout.trim() !== "true") {
  emitVerdict("fail-blocking", "ci-green needs a git workspace.");
  process.exit(0);
}

const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
if (branch.length === 0 || branch === "HEAD") {
  emitVerdict(
    "fail-blocking",
    "ci-green needs a named branch; this workspace is on a detached HEAD.",
  );
  process.exit(0);
}

const repo = readRepo(options.remote);

const token = process.env[options.tokenEnv];
if (token === undefined || token.trim().length === 0) {
  emitVerdict("fail-blocking", `ci-green needs a token in ${options.tokenEnv}.`);
  process.exit(0);
}

const pull = await openPullFor(branch);
if (pull === undefined) {
  // Publishing is somebody else's job. If nothing was put in front of the
  // checks, no Attempt of this Task can change that.
  emitVerdict("fail-blocking", `ci-green found no open pull request for "${branch}".`);
  process.exit(0);
}

// Ask again until the answer settles. The ceiling is this Gate's own timeout:
// reaching it ends the Attempt, and the next one asks from scratch.
for (;;) {
  const checks = await readChecks(pull.sha);
  if (checks === undefined) {
    emitVerdict("fail-blocking", "ci-green cannot read the checks. Is the token allowed to?");
    process.exit(0);
  }
  if (checks.failed.length > 0) {
    emitVerdict("fail-retryable", checks.failed.join("\n"));
    process.exit(0);
  }
  if (checks.total === 0 && options.requireChecks) {
    // Just after a push there is a window where the checks are not created
    // yet, and an empty list then says nothing. Ask again; the Gate's timeout
    // is what ends the wait on a commit no check ever picks up.
    await sleep(options.pollMs);
    continue;
  }
  if (checks.running === 0) {
    emitVerdict("pass");
    process.exit(0);
  }
  await sleep(options.pollMs);
}

/**
 * @param {readonly string[]} tokens
 * @returns {{ ok: true; remote: string; pollMs: number; tokenEnv: string; requireChecks: boolean } | { ok: false; reason: string }}
 */
function parseOwnArgv(tokens) {
  let remote = "origin";
  let pollMs = 15_000;
  let tokenEnv;
  let requireChecks = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--require-checks") {
      requireChecks = true;
      continue;
    }
    const value = tokens[i + 1];
    if (value === undefined) {
      return { ok: false, reason: `ci-green needs a value after ${token}.` };
    }
    i += 1;
    if (token === "--remote") {
      remote = value;
    } else if (token === "--token-env") {
      tokenEnv = value;
    } else if (token === "--poll-ms") {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        return { ok: false, reason: `--poll-ms must be a positive integer, not "${value}".` };
      }
      pollMs = parsed;
    } else {
      return { ok: false, reason: `ci-green does not take "${token}".` };
    }
  }
  if (tokenEnv === undefined) {
    return {
      ok: false,
      reason:
        "ci-green needs --token-env NAME: the environment variable holding a token that can read the checks (the same one @bluewombat/manager-github's tokenEnv names, never GITHUB_TOKEN).",
    };
  }
  return { ok: true, remote, pollMs, tokenEnv, requireChecks };
}

/**
 * The repository the remote points at, or the verdict that there is none. A
 * function rather than a guard so the helpers below can rely on it.
 * @param {string} remote
 * @returns {{ owner: string; name: string }}
 */
function readRepo(remote) {
  const found = repoFrom(git(["remote", "get-url", remote]).stdout.trim());
  if (found === undefined) {
    emitVerdict(
      "fail-blocking",
      `ci-green cannot read a GitHub repository from the "${remote}" remote.`,
    );
    process.exit(0);
  }
  return found;
}

/**
 * `owner/name` from either remote form.
 * @param {string} url
 */
function repoFrom(url) {
  const matched = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
  if (matched?.[1] === undefined || matched[2] === undefined) {
    return undefined;
  }
  return { owner: matched[1], name: matched[2] };
}

/**
 * @param {string} head
 * @returns {Promise<{ number: number; sha: string } | undefined>}
 */
async function openPullFor(head) {
  const listed = await api(
    `/repos/${repo.owner}/${repo.name}/pulls?head=${encodeURIComponent(`${repo.owner}:${head}`)}&state=open&per_page=1`,
  );
  const first = Array.isArray(listed) ? record(listed[0]) : undefined;
  const headOf = first === undefined ? undefined : record(first.head);
  if (first === undefined || headOf === undefined) {
    return undefined;
  }
  return typeof first.number === "number" && typeof headOf.sha === "string"
    ? { number: first.number, sha: headOf.sha }
    : undefined;
}

/** @param {string} sha */
async function readChecks(sha) {
  const body = record(
    await api(`/repos/${repo.owner}/${repo.name}/commits/${sha}/check-runs?per_page=100`),
  );
  const checkRuns = body?.check_runs;
  if (!Array.isArray(checkRuns)) {
    return undefined;
  }
  /** @type {string[]} */
  const failed = [];
  // One workflow can run the same job for two events (push, pull_request)
  // on the same commit: same name, same log. Said once.
  const seen = new Set();
  let running = 0;
  for (const entry of checkRuns) {
    const run = record(entry) ?? {};
    if (run.status !== "completed") {
      running += 1;
      continue;
    }
    if (
      run.conclusion === "success" ||
      run.conclusion === "neutral" ||
      run.conclusion === "skipped"
    ) {
      continue;
    }
    const heading = `${run.name}: ${run.conclusion ?? "failed"}`;
    if (seen.has(heading)) {
      continue;
    }
    seen.add(heading);
    failed.push(`${heading}${typeof run.id === "number" ? await logOf(run.id) : ""}`);
  }
  return { total: checkRuns.length, running, failed };
}

/**
 * The step that failed, out of a failing job's log.
 *
 * A check name and the word "failure" tell the next Attempt nothing it can act
 * on. The reason is in the log — but so is the runner provisioning itself, every
 * step that passed, and the cleanup afterwards, and a reader handed all of that
 * is no better off than one handed none of it.
 *
 * One step refused the work. The runner marks where it broke with `##[error]`
 * and opens every step with `##[group]Run `, so the span from the last such
 * opening to that error is the failing step and nothing else. It is the runner's
 * own structure that says where to cut, not a count of lines chosen here.
 */
/** @param {number} jobId */
async function logOf(jobId) {
  const text = await api(`/repos/${repo.owner}/${repo.name}/actions/jobs/${jobId}/logs`, "text");
  if (typeof text !== "string") {
    return "";
  }
  const lines = text
    .split("\n")
    .map((line) =>
      line
        .replace(/^\S+Z\s/, "")
        .replace(COLOUR, "")
        .trimEnd(),
    )
    .filter((line) => line.trim().length > 0);

  // A job can end without the runner marking anything — cancelled, or killed
  // from outside. Then the last thing it did is the closest there is.
  let end = -1;
  for (let at = 0; at < lines.length; at++) {
    if (lines[at]?.includes("##[error]")) {
      end = at;
    }
  }
  if (end < 0) {
    end = lines.length - 1;
  }

  let start = 0;
  for (let at = end; at >= 0; at--) {
    if (lines[at]?.startsWith(STEP_OPEN)) {
      start = at;
      break;
    }
  }

  const kept = lines
    .slice(start, end + 1)
    .map((line) => line.replace(/^##\[(?:group|endgroup)\]/, ""))
    .filter((line) => line.length > 0);
  return kept.length === 0 ? "" : `\n${kept.join("\n")}`;
}

/**
 * @param {string} path
 * @param {"json" | "text"} [as]
 * @returns {Promise<unknown>}
 */
async function api(path, as = "json") {
  try {
    const response = await fetch(`${API}${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "ci-green-gate",
      },
    });
    if (!response.ok) {
      return undefined;
    }
    return as === "text" ? await response.text() : await response.json();
  } catch {
    return undefined;
  }
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** @param {string[]} args */
function git(args) {
  return spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

/**
 * A JSON object, or nothing: GitHub's answers are read field by field.
 * @param {unknown} value
 * @returns {Record<string, unknown> | undefined}
 */
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : undefined;
}
