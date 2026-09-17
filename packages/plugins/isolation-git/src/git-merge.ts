import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { type FoldStop, IntegrationStoppedError, throwIfStopped } from "@bluewombat/integrator";
import { combinedOutput, runChild, type SpawnRequest } from "./child/run-child.js";
import { runEnv } from "./run-env.js";

const CLEANUP_TIMEOUT_MS = 5_000;
const INCOMING_REF = "refs/integrator/incoming";

export type GitMergeResult =
  | { ok: true }
  | { ok: false; stop: FoldStop }
  | { ok: false; conflict: true; report: string }
  | { ok: false; detail: string };

type GitOk = { ok: true; stdout: string; stderr: string; exitCode: number };
type GitRunResult = GitOk | { ok: false; stop: FoldStop } | { ok: false; detail: string };

function remainingMs(deadlineMs: number, now: number): number {
  return Math.max(1, deadlineMs - now);
}

function parseOid(stdout: string): string | null {
  const line = stdout.trim().split(/\r?\n/)[0]?.trim();
  if (line === undefined || !/^[0-9a-f]{40,64}$/.test(line)) {
    return null;
  }
  return line;
}

async function git(
  args: string[],
  input: {
    cwd: string;
    timeoutMs: number;
    shouldInterrupt: () => boolean;
    env?: NodeJS.ProcessEnv | undefined;
    envOverrides?: NodeJS.ProcessEnv | undefined;
  },
): Promise<GitRunResult> {
  const request: SpawnRequest = {
    argv: ["git", ...args],
    cwd: input.cwd,
    timeoutMs: input.timeoutMs,
    timeoutClock: "integration",
    shouldInterrupt: input.shouldInterrupt,
  };
  if (input.env !== undefined) {
    request.env = input.env;
  }
  // The run's identity and credentials first, then what this call adds.
  request.envOverrides = { ...runEnv(), ...input.envOverrides };
  const outcome = await runChild(request);
  if (outcome.kind === "interrupted") {
    return { ok: false, stop: "interrupt" };
  }
  if (outcome.kind === "timed_out") {
    return { ok: false, stop: "clock" };
  }
  if (outcome.kind === "spawn_error") {
    return { ok: false, detail: `Git could not complete the Integration: ${outcome.detail}` };
  }
  return {
    ok: true,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    exitCode: outcome.exitCode ?? 1,
  };
}

function gitFailed(result: GitOk): { ok: false; detail: string } {
  const detail = combinedOutput(result.stdout, result.stderr) || "git command failed.";
  return { ok: false, detail: `Git could not complete the Integration: ${detail}` };
}

async function restoreGitState(input: {
  parent: string;
  savedHead: string | undefined;
  indexBackup: string | undefined;
}): Promise<void> {
  const quiet = { cwd: input.parent, timeoutMs: CLEANUP_TIMEOUT_MS, shouldInterrupt: () => false };
  await git(["merge", "--abort"], quiet);
  await git(["update-ref", "-d", "MERGE_HEAD"], quiet);
  await git(["update-ref", "-d", INCOMING_REF], quiet);
  if (input.savedHead !== undefined) {
    await git(["update-ref", "HEAD", input.savedHead], quiet);
  }
  if (input.indexBackup !== undefined && existsSync(input.indexBackup)) {
    const indexPath = await git(["rev-parse", "--git-path", "index"], quiet);
    if (indexPath.ok && indexPath.exitCode === 0) {
      const raw = indexPath.stdout.trim();
      const dest = isAbsolute(raw) ? raw : join(input.parent, raw);
      try {
        copyFileSync(input.indexBackup, dest);
      } catch {
        // best-effort index restore
      }
    }
  }
}

/**
 * Three-way git merge of Child working files into Parent. Never forced.
 * Does not fall back to copy.
 *
 * History is left only where something happened: a side with nothing loose
 * gets no snapshot commit, a Parent that never moved is fast-forwarded, and a
 * merge commit exists only when both sides moved. What is written is named
 * after the work (`subject`), not after this mechanism.
 */
export async function gitMerge(input: {
  parent: string;
  child: string;
  /** Names this Integration in what it writes, so history says what was folded. */
  id?: string;
  /** What the folded work is; the commit that carries it says this. */
  subject?: string;
  /** What a merge commit says, when both sides moved. */
  mergeSubject?: string;
  deadlineMs: number;
  now: () => number;
  shouldInterrupt: () => boolean;
}): Promise<GitMergeResult> {
  const { parent, child, id, deadlineMs, now, shouldInterrupt } = input;
  const name = id === undefined ? "Integration" : `Integration of ${id}`;
  const subject = input.subject ?? name;
  const mergeSubject = input.mergeSubject ?? name;
  const shouldStop = (): FoldStop | undefined => {
    if (shouldInterrupt()) {
      return "interrupt";
    }
    if (now() >= deadlineMs) {
      return "clock";
    }
    return undefined;
  };

  let savedHead: string | undefined;
  let indexBackup: string | undefined;
  let wroteParent = false;

  const timed = () => ({
    cwd: parent,
    timeoutMs: remainingMs(deadlineMs, now()),
    shouldInterrupt,
  });

  const failRestore = async (result: GitMergeResult): Promise<GitMergeResult> => {
    await restoreGitState({ parent, savedHead, indexBackup });
    return result;
  };

  /** HEAD is this commit now; the working tree already matches it. */
  const settle = async (oid: string): Promise<GitMergeResult> => {
    if (oid !== savedHead) {
      const updated = await git(["update-ref", "HEAD", oid], timed());
      if (!updated.ok) {
        return failRestore(updated);
      }
      if (updated.exitCode !== 0) {
        return failRestore(gitFailed(updated));
      }
    }
    await git(["update-ref", "-d", INCOMING_REF], {
      cwd: parent,
      timeoutMs: CLEANUP_TIMEOUT_MS,
      shouldInterrupt: () => false,
    });
    if (indexBackup !== undefined) {
      await rm(indexBackup, { force: true });
    }
    return { ok: true };
  };

  try {
    await throwIfStopped(shouldStop);

    if (!existsSync(join(child, ".git"))) {
      return {
        ok: false,
        detail:
          "Git could not complete the Integration: Child is not usable as a git incoming side.",
      };
    }

    const head = await git(["rev-parse", "HEAD"], timed());
    if (!head.ok) {
      return head;
    }
    if (head.exitCode === 0) {
      const oid = parseOid(head.stdout);
      if (oid !== null) {
        savedHead = oid;
      }
    }

    const indexPathResult = await git(["rev-parse", "--git-path", "index"], timed());
    if (!indexPathResult.ok) {
      return indexPathResult;
    }
    if (indexPathResult.exitCode === 0) {
      const raw = indexPathResult.stdout.trim();
      const indexPath = isAbsolute(raw) ? raw : join(parent, raw);
      if (existsSync(indexPath)) {
        indexBackup = join(tmpdir(), `integrator-index-${randomBytes(8).toString("hex")}`);
        copyFileSync(indexPath, indexBackup);
      }
    }

    const parentCommit = await writeWorkingTreeCommit({
      cwd: parent,
      subject,
      deadlineMs,
      now,
      shouldInterrupt,
    });
    if (!parentCommit.ok) {
      return failRestore(parentCommit);
    }

    const childCommit = await writeWorkingTreeCommit({
      cwd: child,
      subject,
      deadlineMs,
      now,
      shouldInterrupt,
    });
    if (!childCommit.ok) {
      return failRestore(childCommit);
    }

    const incoming = await ensureIncomingCommit({
      parent,
      child,
      childCommit: childCommit.oid,
      deadlineMs,
      now,
      shouldInterrupt,
    });
    if (!incoming.ok) {
      return failRestore(incoming);
    }

    await throwIfStopped(shouldStop);

    // Nothing to fold: the Parent already holds everything the Child has.
    if (incoming.oid === parentCommit.oid) {
      return await settle(parentCommit.oid);
    }
    const behind = await isAncestor(incoming.oid, parentCommit.oid, timed());
    if (!behind.ok) {
      return failRestore(behind);
    }
    if (behind.value) {
      return await settle(parentCommit.oid);
    }
    // Only the Child moved: the Parent takes its history as is.
    const ahead = await isAncestor(parentCommit.oid, incoming.oid, timed());
    if (!ahead.ok) {
      return failRestore(ahead);
    }
    if (ahead.value) {
      wroteParent = true;
      const tree = await git(["rev-parse", `${incoming.oid}^{tree}`], timed());
      if (!tree.ok) {
        return failRestore(tree);
      }
      const incomingTree = parseOid(tree.stdout);
      if (tree.exitCode !== 0 || incomingTree === null) {
        return failRestore(gitFailed(tree));
      }
      const checkout = await git(["read-tree", "-u", "--reset", incomingTree], timed());
      if (!checkout.ok) {
        return failRestore(checkout);
      }
      if (checkout.exitCode !== 0) {
        return failRestore(gitFailed(checkout));
      }
      return await settle(incoming.oid);
    }

    const merged = await git(
      ["merge-tree", "--write-tree", parentCommit.oid, incoming.oid],
      timed(),
    );
    if (!merged.ok) {
      return failRestore(merged);
    }
    if (merged.exitCode === 1) {
      return failRestore({
        ok: false,
        conflict: true,
        report: "Cannot fold without choosing a side: overlapping independent changes.",
      });
    }
    if (merged.exitCode !== 0) {
      return failRestore(gitFailed(merged));
    }
    const treeOid = parseOid(merged.stdout);
    if (treeOid === null) {
      return failRestore({
        ok: false,
        detail: "Git could not complete the Integration: merge-tree did not return a tree.",
      });
    }

    await throwIfStopped(shouldStop);
    wroteParent = true;
    const checkout = await git(["read-tree", "-u", "--reset", treeOid], timed());
    if (!checkout.ok) {
      return failRestore(checkout);
    }
    if (checkout.exitCode !== 0) {
      return failRestore(gitFailed(checkout));
    }

    const mergeCommit = await git(
      ["commit-tree", treeOid, "-p", parentCommit.oid, "-p", incoming.oid, "-m", mergeSubject],
      timed(),
    );
    if (!mergeCommit.ok) {
      return failRestore(mergeCommit);
    }
    if (mergeCommit.exitCode !== 0) {
      return failRestore(gitFailed(mergeCommit));
    }
    const mergeOid = parseOid(mergeCommit.stdout);
    if (mergeOid === null) {
      return failRestore({
        ok: false,
        detail: "Git could not complete the Integration: commit-tree did not return a commit.",
      });
    }

    return await settle(mergeOid);
  } catch (error) {
    if (error instanceof IntegrationStoppedError) {
      await restoreGitState({ parent, savedHead, indexBackup });
      return { ok: false, stop: error.stop };
    }
    const detail = error instanceof Error ? error.message : String(error);
    await restoreGitState({ parent, savedHead, indexBackup });
    return {
      ok: false,
      detail: wroteParent
        ? `Integration could not complete: ${detail}`
        : `Git could not complete the Integration: ${detail}`,
    };
  }
}

async function isAncestor(
  ancestor: string,
  descendant: string,
  input: { cwd: string; timeoutMs: number; shouldInterrupt: () => boolean },
): Promise<
  { ok: true; value: boolean } | { ok: false; stop: FoldStop } | { ok: false; detail: string }
> {
  const result = await git(["merge-base", "--is-ancestor", ancestor, descendant], input);
  if (!result.ok) {
    return result;
  }
  if (result.exitCode === 0) {
    return { ok: true, value: true };
  }
  if (result.exitCode === 1) {
    return { ok: true, value: false };
  }
  return gitFailed(result);
}

async function writeWorkingTreeCommit(input: {
  subject: string;
  cwd: string;
  deadlineMs: number;
  now: () => number;
  shouldInterrupt: () => boolean;
}): Promise<
  { ok: true; oid: string } | { ok: false; stop: FoldStop } | { ok: false; detail: string }
> {
  const indexFile = join(tmpdir(), `integrator-idx-${randomBytes(8).toString("hex")}`);
  const envOverrides: NodeJS.ProcessEnv = { GIT_INDEX_FILE: indexFile };
  const timed = () => ({
    cwd: input.cwd,
    timeoutMs: remainingMs(input.deadlineMs, input.now()),
    shouldInterrupt: input.shouldInterrupt,
    envOverrides,
  });

  try {
    const add = await git(["add", "-A", "-f"], timed());
    if (!add.ok) {
      return add;
    }
    if (add.exitCode !== 0) {
      return gitFailed(add);
    }

    const tree = await git(["write-tree"], timed());
    if (!tree.ok) {
      return tree;
    }
    if (tree.exitCode !== 0) {
      return gitFailed(tree);
    }
    const treeOid = parseOid(tree.stdout);
    if (treeOid === null) {
      return {
        ok: false,
        detail: "Git could not complete the Integration: write-tree did not return a tree.",
      };
    }

    const commitArgs = ["commit-tree", treeOid, "-m", input.subject];
    const head = await git(["rev-parse", "HEAD", "HEAD^{tree}"], {
      cwd: input.cwd,
      timeoutMs: remainingMs(input.deadlineMs, input.now()),
      shouldInterrupt: input.shouldInterrupt,
    });
    if (!head.ok) {
      return head;
    }
    if (head.exitCode === 0) {
      const [headLine, headTreeLine] = head.stdout.trim().split(/\r?\n/);
      const headOid = parseOid(headLine ?? "");
      if (headOid !== null) {
        // Nothing loose: HEAD already is the snapshot.
        if (parseOid(headTreeLine ?? "") === treeOid) {
          return { ok: true, oid: headOid };
        }
        commitArgs.push("-p", headOid);
      }
    }

    const commit = await git(commitArgs, {
      cwd: input.cwd,
      timeoutMs: remainingMs(input.deadlineMs, input.now()),
      shouldInterrupt: input.shouldInterrupt,
      envOverrides,
    });
    if (!commit.ok) {
      return commit;
    }
    if (commit.exitCode !== 0) {
      return gitFailed(commit);
    }
    const oid = parseOid(commit.stdout);
    if (oid === null) {
      return {
        ok: false,
        detail: "Git could not complete the Integration: commit-tree did not return a commit.",
      };
    }
    return { ok: true, oid };
  } finally {
    await rm(indexFile, { force: true });
    await rm(`${indexFile}.lock`, { force: true });
  }
}

async function ensureIncomingCommit(input: {
  parent: string;
  child: string;
  childCommit: string;
  deadlineMs: number;
  now: () => number;
  shouldInterrupt: () => boolean;
}): Promise<
  { ok: true; oid: string } | { ok: false; stop: FoldStop } | { ok: false; detail: string }
> {
  const timed = (cwd: string) => ({
    cwd,
    timeoutMs: remainingMs(input.deadlineMs, input.now()),
    shouldInterrupt: input.shouldInterrupt,
  });

  const parentCommon = await git(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    timed(input.parent),
  );
  if (!parentCommon.ok) {
    return parentCommon;
  }
  if (parentCommon.exitCode !== 0) {
    return gitFailed(parentCommon);
  }
  const childCommon = await git(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    timed(input.child),
  );
  if (!childCommon.ok) {
    return childCommon;
  }
  if (childCommon.exitCode !== 0) {
    return gitFailed(childCommon);
  }

  const parentDir = resolve(parentCommon.stdout.trim());
  const childDir = resolve(childCommon.stdout.trim());
  if (parentDir === childDir) {
    return { ok: true, oid: input.childCommit };
  }

  const fetched = await git(
    ["fetch", "--no-tags", input.child, `${input.childCommit}:${INCOMING_REF}`],
    timed(input.parent),
  );
  if (!fetched.ok) {
    return fetched;
  }
  if (fetched.exitCode !== 0) {
    return gitFailed(fetched);
  }
  return { ok: true, oid: input.childCommit };
}
