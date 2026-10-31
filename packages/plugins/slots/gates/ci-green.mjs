#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { emitVerdict, GATE_FLAGS, ownArgv, take } from "@bluewombat/slot-kit";

// The work line's own checks, on the work this workspace published: GitHub
// Actions' check runs, and the commit statuses CI outside Actions reports
// (Vercel, Netlify, Jenkins…), the two lists GitHub itself shows on a PR.
//
// It reads and nothing else: it does not push, does not open anything, does not
// merge. Whoever put the work in front of the checks did that before this Gate
// ran; this Gate only says whether the answer came back green.
//
//   --remote NAME        default: origin
//   --api-base URL       default: https://api.github.com (GitHub Enterprise)
//   --poll-ms N          how often to ask again while checks are running
//   --token-env NAME     required: the variable holding a token that can read
//                        the checks. No default on purpose — GITHUB_TOKEN is the
//                        one name `gh` reads ahead of its own login, so an
//                        operator must not export it, and a Gate that fell back
//                        to it failed only at the first assembly of a real run
//   --require-checks     wait for a check to appear; without it, a commit with no
//                        check at all passes
//   --require-check NAME repeatable. The check run (or status context) called
//                        exactly NAME must exist and have succeeded. A `skipped` or
//                        `neutral` one is not a pass, which is what the general
//                        rule lets through (a job skipped for want of its secrets
//                        would let the line go green): it is refused. One not
//                        there yet is waited for like --require-checks, and at the
//                        ceiling the CI did not answer. A matrix is one check per
//                        cell, named as GitHub names it ("e2e (chrome)"): list each one.
//
// It also receives `--timeout-ms` from Implementer: the ceiling it will be
// killed at. A Gate that waits on a CI it does not run must not wait to be cut
// off: a kill reads as "refused", and a refusal sends the work to an agent that
// has nothing to fix. Near that ceiling it says so itself, `fail-blocking`, with
// what it was waiting for.

// What the runner writes at the top of every step it runs.
const STEP_OPEN = "##[group]Run ";
const COLOUR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

const cwd = process.cwd();
const options = parseOwnArgv(ownArgv(process.argv, GATE_FLAGS));
if (!options.ok) {
  emitVerdict("fail-blocking", options.reason);
  process.exit(0);
}
const apiBase = options.apiBase;
const requireCheck = options.requireCheck;

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

// Ask again until the answer settles, or until just before Implementer would
// kill this Gate (`--timeout-ms`); without that flag, until it does.
const startedAt = Date.now();
const stopAt = stopTime(startedAt, take(process.argv, "--timeout-ms"));
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
    // yet, and an empty list then says nothing. Ask again, until the wait
    // runs out: a commit no check ever picks up is not a refusal of the work.
    if (Date.now() >= stopAt) {
      stopWaiting(pull, "no check has appeared", true);
    }
    await sleep(Math.min(options.pollMs, Math.max(0, stopAt - Date.now())));
    continue;
  }
  const required = judgeRequired(checks.named);
  if (required.refused.length > 0) {
    // A check that settled without running says nothing of the work, and nothing
    // the work could change (a job skipped for want of its secrets): a person's,
    // not an agent's to repair.
    emitVerdict(
      "fail-blocking",
      `${required.refused.join("\n")}\nThis is not a refusal of the work: the CI did not run a check the Project requires, and no change to the work makes it run.`,
    );
    process.exit(0);
  }
  if (required.missing.length > 0) {
    // Same window as above, for a check the Project named.
    if (Date.now() >= stopAt) {
      stopWaiting(pull, `required check ${quoted(required.missing)} has not appeared`, true);
    }
    await sleep(Math.min(options.pollMs, Math.max(0, stopAt - Date.now())));
    continue;
  }
  if (checks.running === 0) {
    emitVerdict("pass");
    process.exit(0);
  }
  if (Date.now() >= stopAt) {
    stopWaiting(
      pull,
      `${checks.running} check${checks.running === 1 ? " was" : "s were"} still running`,
    );
  }
  await sleep(Math.min(options.pollMs, Math.max(0, stopAt - Date.now())));
}

/**
 * What `--require-check` asks of the checks read: each name must have a
 * success. A name not there yet is `missing` (the CI may still create it); one
 * still running is waited for with the rest; one that settled without success
 * (`skipped`, `neutral`) is `refused`: nothing will turn it green, and no change
 * to the work can, so it goes to a person.
 *
 * @param {Map<string, string[]>} named every check by name, with its outcome:
 *   `success`, `pending`, or the conclusion it settled on
 * @returns {{ missing: string[]; refused: string[] }}
 */
function judgeRequired(named) {
  /** @type {string[]} */
  const missing = [];
  /** @type {string[]} */
  const refused = [];
  for (const name of requireCheck) {
    const outcomes = named.get(name);
    if (outcomes === undefined) {
      missing.push(name);
    } else if (!outcomes.includes("success") && !outcomes.includes("pending")) {
      refused.push(
        `${name}: ${outcomes[0]}. It is required to succeed, and a check that did not run is not a pass.`,
      );
    }
  }
  return { missing, refused };
}

/** @param {readonly string[]} names */
function quoted(names) {
  return names.map((name) => `"${name}"`).join(", ");
}

/**
 * The moment to stop waiting: a margin before Implementer's ceiling (5 %, between
 * 2 and 30 seconds, and at most half of it), so the verdict is out before the
 * kill. `Infinity` when Implementer gave no ceiling.
 *
 * @param {number} from
 * @param {string | undefined} raw
 */
function stopTime(from, raw) {
  const ceiling = Number.parseInt(raw ?? "", 10);
  if (!Number.isInteger(ceiling) || ceiling <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  const margin = Math.min(Math.max(2_000, ceiling * 0.05), 30_000, ceiling / 2);
  return from + ceiling - margin;
}

/**
 * The CI did not answer. That says nothing of the work, and nothing the work
 * could change: blocking, so a person reads it instead of an agent being sent
 * to repair what was never judged.
 *
 * When no check ever appeared, the cause is on the repository's side, and the
 * message says the three it can be: no CI at all, a CI that does not run on pull
 * requests into this branch, or a CI that is late.
 *
 * @param {{ number: number; sha: string; base?: string }} pr
 * @param {string} what
 * @param {boolean} [never]
 * @returns {never}
 */
function stopWaiting(pr, what, never = false) {
  const seconds = Math.round((Date.now() - startedAt) / 1000);
  const lasted = seconds >= 120 ? `${Math.round(seconds / 60)} min` : `${seconds} s`;
  const into = pr.base === undefined ? "this branch" : `"${pr.base}"`;
  const hint = never
    ? ` Either this repository has no CI (then take ci-green out of the Gate list), or its workflows do not run on pull requests into ${into}, or the CI was removed or is late.`
    : "";
  emitVerdict(
    "fail-blocking",
    `ci-green stopped waiting after ${lasted}: ${what} on ${pr.sha.slice(0, 7)} (pull request #${pr.number}). The CI did not answer in time; this is not a refusal of the work, and no change to it can make the CI answer.${hint}`,
  );
  process.exit(0);
}

/**
 * @param {readonly string[]} tokens
 * @returns {{ ok: true; remote: string; apiBase: string; pollMs: number; tokenEnv: string; requireChecks: boolean; requireCheck: string[] } | { ok: false; reason: string }}
 */
function parseOwnArgv(tokens) {
  let remote = "origin";
  let apiBase = "https://api.github.com";
  let pollMs = 15_000;
  let tokenEnv;
  let requireChecks = false;
  /** @type {string[]} */
  const requireCheck = [];
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
    } else if (token === "--api-base") {
      apiBase = value.replace(/\/+$/, "");
    } else if (token === "--require-check") {
      requireCheck.push(value);
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
  return { ok: true, remote, apiBase, pollMs, tokenEnv, requireChecks, requireCheck };
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
 * @returns {Promise<{ number: number; sha: string; base?: string } | undefined>}
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
  const baseOf = record(first.base);
  const base = typeof baseOf?.ref === "string" ? baseOf.ref : undefined;
  return typeof first.number === "number" && typeof headOf.sha === "string"
    ? { number: first.number, sha: headOf.sha, ...(base === undefined ? {} : { base }) }
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
  // A token that may read check runs but not statuses reads as no status at
  // all: what this Gate did before it read them.
  const combined = record(
    await api(`/repos/${repo.owner}/${repo.name}/commits/${sha}/status?per_page=100`),
  );
  const statuses = Array.isArray(combined?.statuses) ? combined.statuses : [];
  /** @type {string[]} */
  const failed = [];
  // One workflow can run the same job for two events (push, pull_request)
  // on the same commit: same name, same log. Said once.
  const seen = new Set();
  let running = 0;
  /** @type {Map<string, string[]>} */
  const named = new Map();
  /**
   * @param {unknown} name
   * @param {string} outcome
   */
  const note = (name, outcome) => {
    if (typeof name === "string") {
      named.set(name, [...(named.get(name) ?? []), outcome]);
    }
  };
  for (const entry of checkRuns) {
    const run = record(entry) ?? {};
    if (run.status !== "completed") {
      running += 1;
      note(run.name, "pending");
      continue;
    }
    note(run.name, String(run.conclusion));
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
  // The latest status per context. No log to cut here: what the reporter said
  // and where it said more is all there is.
  for (const entry of statuses) {
    const status = record(entry) ?? {};
    note(status.context, status.state === "pending" ? "pending" : String(status.state));
    if (status.state === "pending") {
      running += 1;
      continue;
    }
    if (status.state === "success") {
      continue;
    }
    const heading = `${status.context}: ${status.state ?? "failed"}`;
    if (seen.has(heading)) {
      continue;
    }
    seen.add(heading);
    const more = [status.description, status.target_url].filter(
      (text) => typeof text === "string" && text.length > 0,
    );
    failed.push([heading, ...more].join("\n"));
  }
  return { total: checkRuns.length + statuses.length, running, failed, named };
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
    const response = await fetch(`${apiBase}${path}`, {
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
