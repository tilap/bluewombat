import { spawnSync } from "node:child_process";

/**
 * Git remotes, for `init` and `doctor`: what a copy points at, what a remote
 * holds, and a clone of one branch. Whether a path *is* a work line is the
 * loop's question — `inspectWorkLine` in `loop/work-line.ts`.
 */

/**
 * The remotes that work line copy knows, by name.
 *
 * Offline on purpose: the question here is whether the name is configured at
 * all, which is the one that turns a run that silently does nothing into a
 * refusal at startup. Whether that remote answers is the network's business.
 */
export function remoteNames(path: string): string[] {
  const listed = git(["remote"], path);
  return listed.ok
    ? listed.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
    : [];
}

/**
 * Whether the remote really carries that branch.
 *
 * Cheap, and it is the check that turns "cloned the wrong thing" into a
 * question asked before anything is written to disk.
 */
export function remoteBranches(
  remote: string,
): { ok: true; names: string[] } | { ok: false; reason: string } {
  const listed = git(["ls-remote", "--heads", remote]);
  if (!listed.ok) {
    return { ok: false, reason: listed.stderr.trim() || `Cannot reach ${remote}` };
  }
  const names: string[] = [];
  for (const line of listed.stdout.split("\n")) {
    const ref = line.split("\t")[1];
    if (ref?.startsWith("refs/heads/")) {
      names.push(ref.slice("refs/heads/".length));
    }
  }
  return { ok: true, names };
}

/**
 * The branch a bare `git clone` would land on. `ls-remote --symref` answers it
 * without fetching anything, so `--clone` needs no `--branch` to do the
 * obvious thing.
 */
export function remoteHead(remote: string): string | undefined {
  const listed = git(["ls-remote", "--symref", remote, "HEAD"]);
  if (!listed.ok) {
    return undefined;
  }
  for (const line of listed.stdout.split("\n")) {
    const matched = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/.exec(line.trim());
    if (matched?.[1] !== undefined) {
      return matched[1];
    }
  }
  return undefined;
}

export function cloneWorkLine(
  remote: string,
  branch: string,
  path: string,
): { ok: true } | { ok: false; reason: string } {
  const cloned = git(["clone", "--branch", branch, "--single-branch", remote, path]);
  return cloned.ok
    ? { ok: true }
    : { ok: false, reason: cloned.stderr.trim() || "git clone failed" };
}

function git(argv: string[], cwd?: string): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("git", argv, {
    encoding: "utf8",
    ...(cwd === undefined ? {} : { cwd }),
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? String(result.error ?? ""),
  };
}
