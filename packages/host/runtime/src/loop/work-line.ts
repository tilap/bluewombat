import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { ISOLATION_GIT } from "../config/defaults.js";
import { inHome } from "../config/home.js";
import type {
  IsolationStrategy,
  ParsedReference,
  ReferenceCopyState,
} from "../plugins/isolation.js";

export type WorkLineState =
  | { kind: "missing" }
  | { kind: "not-a-directory" }
  | { kind: "plain" }
  | { kind: "git"; branch: string };

/** What is at that path today. Integrator folds by merge only on a git tree. */
export function inspectWorkLine(path: string): WorkLineState {
  if (!existsSync(path)) {
    return { kind: "missing" };
  }
  if (!statSync(path).isDirectory()) {
    return { kind: "not-a-directory" };
  }
  if (!existsSync(join(path, ".git"))) {
    return { kind: "plain" };
  }
  return { kind: "git", branch: branchOf(path) };
}

/**
 * `symbolic-ref` first: it answers on a repository with no commit yet, where
 * `rev-parse HEAD` has nothing to resolve. `rev-parse` is the fallback for a
 * detached HEAD.
 */
function branchOf(path: string): string {
  const symbolic = git(["symbolic-ref", "--short", "HEAD"], path);
  if (symbolic.ok && symbolic.stdout.trim().length > 0) {
    return symbolic.stdout.trim();
  }
  const revision = git(["rev-parse", "--short", "HEAD"], path);
  return revision.ok ? `detached at ${revision.stdout.trim()}` : "unknown";
}

export type WorkLineInput = {
  /** Host's own directory; the copy of a reference lives there unless `stable` says otherwise. */
  home: string;
  /** `workLine.stable`, when the operator set it. */
  stable: string | undefined;
  /** `workLine.branch`, when the operator set it. */
  branch: string | undefined;
  /** The manager's name, for the messages. */
  manager: string;
  /** `authority.enabled`. Without one, the work line is the operator's whatever the manager names. */
  wantsAuthority: boolean;
  /** What `referenceManager` returned, unread. */
  reference: Record<string, unknown> | undefined;
  strategy: IsolationStrategy;
  strategyName: string;
};

/**
 * Which directory is the work line, and whose it is.
 *
 * - `operators`: no reference is named, so `workLine.stable` is a work line
 *   the operator maintains — the fold lands there and that is final.
 * - `unchecked`: a reference is named but this strategy cannot read one, so an
 *   explicit `workLine.stable` is taken on trust, as before any of this.
 * - `copy`: a reference is named and read. The directory is Host's copy of it,
 *   whether the operator chose the path or the default did.
 * - `invalid`: something disagrees, and the run must not start.
 */
export type WorkLineResolution =
  | { kind: "operators"; stable: string }
  | { kind: "unchecked"; stable: string; reason: string }
  | {
      kind: "copy";
      stable: string;
      target: string;
      reference: ParsedReference;
      state: ReferenceCopyState;
    }
  | { kind: "invalid"; reason: string };

/** Offline. Everything here reads; `materializeWorkLine` is the one write. */
export function resolveWorkLine(input: WorkLineInput): WorkLineResolution {
  // A reference is where an Authority keeps the work line. With none, the
  // fold lands here and is final, so the directory is the operator's — even
  // when the manager could name one.
  if (input.reference === undefined || !input.wantsAuthority) {
    if (input.stable === undefined) {
      const why = input.wantsAuthority
        ? `${input.manager} names no reference work line to copy from`
        : "without an Authority the fold lands here and is final";
      return {
        kind: "invalid",
        reason: `"workLine.stable" is not set, and ${why}. Set it to the directory the work is folded into.`,
      };
    }
    return { kind: "operators", stable: input.stable };
  }
  const backend = input.strategy.reference;
  if (backend === undefined) {
    const reason = `${input.manager} names a reference work line, but ${input.strategyName} cannot keep a copy of one.`;
    if (input.stable === undefined) {
      return {
        kind: "invalid",
        reason: `${reason} Set "workLine.stable" to a copy you maintain, or use a strategy that can (e.g. "${ISOLATION_GIT}").`,
      };
    }
    return { kind: "unchecked", stable: input.stable, reason };
  }
  const parsed = backend.parse(input.reference);
  if (!parsed.ok) {
    return {
      kind: "invalid",
      reason: `${input.strategyName} cannot read the reference work line ${input.manager} names: ${parsed.reason}.`,
    };
  }
  if (input.branch !== undefined && input.branch !== parsed.target) {
    return {
      kind: "invalid",
      reason: `"workLine.branch" is "${input.branch}", but ${input.manager} names "${parsed.target}" as the reference. Drop the key, or make them agree.`,
    };
  }
  const stable = input.stable ?? inHome(input.home, "workLine");
  return {
    kind: "copy",
    stable,
    target: parsed.target,
    reference: parsed,
    state: parsed.inspect(stable),
  };
}

/**
 * Bring a `copy` resolution to a directory a run can use: fetch a missing one,
 * refuse a directory that is not a copy of the reference. Network.
 */
export async function materializeWorkLine(
  resolution: Extract<WorkLineResolution, { kind: "copy" }>,
): Promise<{ ok: true; fetched: boolean } | { ok: false; reason: string }> {
  if (resolution.state.kind === "matches") {
    return { ok: true, fetched: false };
  }
  if (resolution.state.kind === "mismatch") {
    return {
      ok: false,
      reason: `${resolution.stable} is not a copy of ${resolution.reference.summary}: ${resolution.state.reason}. Move it, or point "workLine.stable" elsewhere.`,
    };
  }
  const made = await resolution.reference.materialize(resolution.stable);
  if (!made.ok) {
    return {
      ok: false,
      reason: `Cannot copy ${resolution.reference.summary} to ${resolution.stable}: ${made.reason}`,
    };
  }
  return { ok: true, fetched: true };
}

function git(argv: string[], cwd: string): { ok: boolean; stdout: string } {
  const result = spawnSync("git", argv, { encoding: "utf8", cwd });
  return { ok: result.status === 0, stdout: result.stdout ?? "" };
}
