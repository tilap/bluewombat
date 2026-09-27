import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { envFor, type GitIdentity, runEnv, setRunEnv } from "./run-env.js";
import type { ParsedReference, ReferenceBackend, ReferenceCopyState } from "./types.js";

const KEYS = ["remote", "branch", "credentialEnv", "author"] as const;
const REQUIRED = ["remote", "branch"] as const;
const REMOTE = "origin";

type GitReference = {
  remote: string;
  branch: string;
  credentialEnv?: string | undefined;
  author?: GitIdentity | undefined;
};

/**
 * A reference work line, for git: a remote and a branch on it; and, when the
 * manager says so, how the system is named on what it commits (`author`) and
 * which environment variable holds the token git authenticates with
 * (`credentialEnv`). Both become the git environment of this run — see
 * `run-env.ts` — so the commits and the pushes are the system's, not the
 * machine's.
 *
 * The copy is a single-branch clone whose `origin` is that remote — the shape
 * the git Publisher pushes to and the git Refresher reads from, and the one
 * they assume without an option to say otherwise.
 */
export const gitReference: ReferenceBackend = {
  parse(raw) {
    for (const key of Object.keys(raw)) {
      if (!(KEYS as readonly string[]).includes(key)) {
        return {
          ok: false,
          reason: `unknown key "${key}" — a git reference has ${KEYS.join(", ")}`,
        };
      }
    }
    const remote = nonEmptyString(raw, "remote");
    if (!remote.ok) {
      return remote;
    }
    const branch = nonEmptyString(raw, "branch");
    if (!branch.ok) {
      return branch;
    }
    const credentialEnv = optionalString(raw, "credentialEnv");
    if (!credentialEnv.ok) {
      return credentialEnv;
    }
    const author = optionalAuthor(raw);
    if (!author.ok) {
      return author;
    }
    const reference: GitReference = {
      remote: remote.value,
      branch: branch.value,
      credentialEnv: credentialEnv.value,
      author: author.value,
    };
    setRunEnv(envFor(reference));
    return parsed(reference);
  },
};

function optionalString(
  raw: Record<string, unknown>,
  key: (typeof KEYS)[number],
): { ok: true; value: string | undefined } | { ok: false; reason: string } {
  const value = raw[key];
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return { ok: false, reason: `"${key}" must be a non-empty string` };
  }
  return { ok: true, value: value.trim() };
}

/** `author` is `{ name, email }`, both non-empty; anything else is refused. */
function optionalAuthor(
  raw: Record<string, unknown>,
): { ok: true; value: GitIdentity | undefined } | { ok: false; reason: string } {
  const value = raw.author;
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: '"author" must be { name, email }' };
  }
  const { name, email } = value as Record<string, unknown>;
  if (typeof name !== "string" || name.trim().length === 0) {
    return { ok: false, reason: '"author.name" must be a non-empty string' };
  }
  if (typeof email !== "string" || email.trim().length === 0) {
    return { ok: false, reason: '"author.email" must be a non-empty string' };
  }
  return { ok: true, value: { name: name.trim(), email: email.trim() } };
}

function nonEmptyString(
  raw: Record<string, unknown>,
  key: (typeof REQUIRED)[number],
): { ok: true; value: string } | { ok: false; reason: string } {
  const value = raw[key];
  if (value === undefined) {
    return { ok: false, reason: `missing "${key}" — a git reference has ${REQUIRED.join(", ")}` };
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return { ok: false, reason: `"${key}" must be a non-empty string` };
  }
  return { ok: true, value: value.trim() };
}

function parsed(reference: GitReference): ParsedReference {
  return {
    ok: true,
    summary: `${reference.remote} (${reference.branch})`,
    target: reference.branch,
    inspect: (path) => inspectCopy(reference, path),
    materialize: async (path) => materializeCopy(reference, path),
    env: runEnv(),
  };
}

/**
 * Whether what is at `path` is a copy of this reference: a git tree, whose
 * `origin` is the remote, checked out on the branch. Anything else is somebody
 * else's directory, and this system does not write over those.
 */
function inspectCopy(reference: GitReference, path: string): ReferenceCopyState {
  if (!existsSync(path)) {
    return { kind: "missing" };
  }
  if (!statSync(path).isDirectory()) {
    return { kind: "mismatch", reason: `${path} exists and is not a directory` };
  }
  if (!existsSync(join(path, ".git"))) {
    return { kind: "mismatch", reason: `${path} is not a git tree` };
  }
  const url = git(["remote", "get-url", REMOTE], path);
  if (!url.ok) {
    return { kind: "mismatch", reason: `${path} has no "${REMOTE}" remote` };
  }
  if (sameRemote(url.stdout.trim(), reference.remote) === false) {
    return {
      kind: "mismatch",
      reason: `${path} has "${REMOTE}" at ${url.stdout.trim()}, not ${reference.remote}`,
    };
  }
  const branch = git(["symbolic-ref", "--short", "HEAD"], path);
  const checkedOut = branch.ok ? branch.stdout.trim() : "a detached HEAD";
  if (checkedOut !== reference.branch) {
    return {
      kind: "mismatch",
      reason: `${path} is on "${checkedOut}", not "${reference.branch}"`,
    };
  }
  return { kind: "matches" };
}

/** `.git` and a trailing slash are spelling, not a different remote. */
function sameRemote(a: string, b: string): boolean {
  const trim = (url: string): string => url.replace(/\/+$/, "").replace(/\.git$/, "");
  return trim(a) === trim(b);
}

/**
 * A single-branch clone, after the branch has been shown to exist: a
 * `git clone --branch` that misses fails with a message about a repository,
 * not about the name that was wrong.
 */
function materializeCopy(
  reference: GitReference,
  path: string,
): { ok: true } | { ok: false; reason: string } {
  const listed = git(["ls-remote", "--heads", reference.remote]);
  if (!listed.ok) {
    return {
      ok: false,
      reason: `cannot reach ${reference.remote}: ${listed.stderr.trim() || "git ls-remote failed"}`,
    };
  }
  const names: string[] = [];
  for (const line of listed.stdout.split("\n")) {
    const ref = line.split("\t")[1];
    if (ref?.startsWith("refs/heads/")) {
      names.push(ref.slice("refs/heads/".length));
    }
  }
  if (!names.includes(reference.branch)) {
    return {
      ok: false,
      reason: `${reference.remote} has no branch "${reference.branch}". It has: ${names.join(", ")}`,
    };
  }
  mkdirSync(dirname(path), { recursive: true });
  const cloned = git([
    "clone",
    "--branch",
    reference.branch,
    "--single-branch",
    reference.remote,
    path,
  ]);
  if (!cloned.ok) {
    return { ok: false, reason: cloned.stderr.trim() || "git clone failed" };
  }
  return { ok: true };
}

function git(argv: string[], cwd?: string): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("git", argv, {
    encoding: "utf8",
    // C locale: a failed clone's words are the reason `mason run` stops on.
    env: { ...process.env, ...runEnv(), LC_ALL: "C" },
    ...(cwd === undefined ? {} : { cwd }),
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? String(result.error ?? ""),
  };
}
