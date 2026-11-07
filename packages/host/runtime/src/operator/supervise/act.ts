import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PRODUCT } from "@bluewombat/manager-kit";
import type { FixTarget, SupervisorConfig } from "./config.js";
import { runAgent } from "./council.js";
import type { Decision, Fix, Unblock } from "./decision.js";
import { type Exec, fill, succeeded, tail } from "./exec.js";
import { fixerPrompt, proposalReviewerPrompt, reviewerPrompt } from "./prompts.js";
import { parseVerdict } from "./review.js";

/** `pending`: done on this side (offered), but not in effect until a person folds it. */
export type Outcome = { what: string; ok: boolean; detail: string; pending?: boolean };

/** What touches the ledger or the worker, which only the supervisor's own process can do. */
export type Hands = {
  restart(key: string): Promise<Outcome>;
  cancel(key: string): Promise<Outcome>;
  startWorker(): Promise<Outcome>;
  restartWorker(): Promise<Outcome>;
};

export type ActContext = {
  config: SupervisorConfig;
  exec: Exec;
  hands: Hands;
  /** Where this incident's files are kept. */
  dir: string;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
};

/** A fix that is offered and folded within this long, or it is reported as not folded. */
const FOLD_WAIT_MS = 60 * 60_000;
const FOLD_POLL_MS = 20_000;
/** Rounds the agent gets to make its change pass the checks. */
const FIX_ROUNDS = 3;
/** The guard gets the diff in its prompt up to this long; beyond, it reads the tree. */
const DIFF_CHARS = 60_000;

/**
 * Do what the arbiter decided.
 *
 * The order is the arbiter's: when the same stop would come straight back
 * without the fixes, they land first and the run is unblocked after; a fix
 * that did not land holds the unblock back. Otherwise the run moves first and
 * the fixes follow while it works. Nothing here chooses: it carries out.
 */
export async function carryOut(decision: Decision, context: ActContext): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];
  const fix = async (): Promise<boolean> => {
    let landed = true;
    for (const item of decision.fixes) {
      const outcome = await landFix(item, decision, context);
      outcomes.push(outcome);
      landed &&= outcome.ok && outcome.pending !== true;
    }
    return landed;
  };
  const unblock = async (): Promise<void> => {
    for (const item of decision.unblock) {
      outcomes.push(await unblockOne(item, context));
    }
  };
  if (decision.unblockAfterFixes) {
    if (await fix()) {
      await unblock();
    } else {
      outcomes.push({
        what: "unblock",
        ok: false,
        detail: outcomes.some((o) => o.pending === true)
          ? "held: the fixes wait for a person to fold them, and without them the same stop comes back"
          : "held: the fixes did not land, and without them the same stop comes back",
      });
    }
  } else {
    await unblock();
    await fix();
  }
  return outcomes;
}

async function unblockOne(item: Unblock, context: ActContext): Promise<Outcome> {
  const what = `${item.do}${item.key === undefined ? "" : ` ${item.key}`}`;
  const { config, exec, hands } = context;
  switch (item.do) {
    case "restart":
      return await hands.restart(item.key ?? "");
    case "cancel":
      return await hands.cancel(item.key ?? "");
    case "start-worker":
      return await hands.startWorker();
    case "restart-worker":
      return await hands.restartWorker();
    case "resume": {
      if (config.resume === undefined) {
        return { what, ok: false, detail: "no `resume` command in the supervisor config" };
      }
      const key = item.key ?? "";
      const number = /#(\d+)$/.exec(key)?.[1] ?? key;
      const result = await exec(fill(config.resume.cmd, { key, number }), {
        timeoutMs: config.resume.timeoutMs,
      });
      return {
        what,
        ok: succeeded(result),
        detail: succeeded(result) ? "signalled" : tail(result),
      };
    }
    case "cleanup-disk": {
      for (const step of config.diskCleanup) {
        const result = await exec(step.cmd, { timeoutMs: step.timeoutMs });
        if (!succeeded(result)) {
          return { what, ok: false, detail: `${step.cmd.join(" ")}: ${tail(result)}` };
        }
      }
      return {
        what,
        ok: config.diskCleanup.length > 0,
        detail:
          config.diskCleanup.length > 0 ? "cleaned" : "no `diskCleanup` in the supervisor config",
      };
    }
  }
}

/** Change a repository, offer the change, see it folded, run what follows. */
async function landFix(fix: Fix, decision: Decision, context: ActContext): Promise<Outcome> {
  const what = `fix ${fix.target}: ${fix.title}`;
  if (fix.revises !== undefined) {
    return {
      what,
      ok: false,
      detail: `not made: it would revise ${fix.revises}. That is for a person to decide`,
    };
  }
  const target = context.config.targets.find((t) => t.name === fix.target);
  if (target === undefined) {
    return { what, ok: false, detail: `no target "${fix.target}" in the supervisor config` };
  }
  const stamp = (context.now ?? (() => new Date()))().toISOString().replace(/\D/g, "").slice(0, 14);
  const slug = fix.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  const branch = `supervisor/${stamp}-${slug}`;
  const tree = join(context.config.dir, "work", `${stamp}-${slug}`);
  const git = (args: string[], cwd: string, timeoutMs = 5 * 60_000) =>
    context.exec(["git", ...args], { cwd, timeoutMs });
  const say = context.log ?? (() => {});

  const fetched = await git(["fetch", target.remote, target.base], target.repo);
  if (!succeeded(fetched)) {
    return { what, ok: false, detail: `fetch: ${tail(fetched)}` };
  }
  mkdirSync(join(context.config.dir, "work"), { recursive: true });
  const added = await git(
    ["worktree", "add", "-b", branch, tree, `${target.remote}/${target.base}`],
    target.repo,
  );
  if (!succeeded(added)) {
    return { what, ok: false, detail: `worktree: ${tail(added)}` };
  }
  try {
    const made = await makeChange(fix, decision, target, tree, branch, context, git);
    if (!made.ok) {
      return { what, ...made };
    }
    say(`fix ${branch}: checks pass, offering`);
    const body = join(context.dir, `${slug}.pr.md`);
    writeFileSync(
      body,
      `${decision.summary}\n\n## Cause\n${decision.cause}\n\n## Evidence\n${decision.evidence.map((e) => `- ${e}`).join("\n")}\n\n## Guard\nApproved by an agent that did not see the stop. It checked:\n${made.checked.map((e) => `- ${e}`).join("\n")}\n\nMade by the ${PRODUCT} supervisor from incident ${context.dir}.\n`,
    );
    const pushed = await git(["push", "-u", target.remote, branch], tree);
    if (!succeeded(pushed)) {
      return { what, ok: false, detail: `push: ${tail(pushed)}` };
    }
    const vars = { branch, title: fix.title, bodyFile: body };
    const opened = await context.exec(fill(target.open.cmd, vars), {
      cwd: tree,
      timeoutMs: target.open.timeoutMs,
    });
    if (!succeeded(opened)) {
      return { what, ok: false, detail: `open: ${tail(opened)}` };
    }
    const pr = opened.stdout.trim().split("\n").pop()?.trim() ?? "";
    if (!target.autoMerge) {
      return {
        what,
        ok: true,
        pending: true,
        detail: `${pr} offered, waiting for a person to fold it`,
      };
    }
    const merging = await context.exec(fill(target.merge.cmd, { ...vars, pr }), {
      cwd: tree,
      timeoutMs: target.merge.timeoutMs,
    });
    if (!succeeded(merging)) {
      return { what, ok: false, detail: `merge ${pr}: ${tail(merging)}` };
    }
    const folded = await waitFolded(target, pr, tree, context);
    if (!folded) {
      return {
        what,
        ok: false,
        detail: `${pr} was offered but is not folded after ${FOLD_WAIT_MS / 60_000} min`,
      };
    }
    for (const step of target.after) {
      const result = await context.exec(fill(step.cmd, vars), {
        cwd: target.repo,
        timeoutMs: step.timeoutMs,
      });
      if (!succeeded(result)) {
        return {
          what,
          ok: false,
          detail: `${pr} folded, then \`${step.cmd.join(" ")}\` failed: ${tail(result)}`,
        };
      }
    }
    return { what, ok: true, detail: `${pr} folded` };
  } finally {
    await git(["worktree", "remove", "--force", tree], target.repo);
  }
}

async function makeChange(
  fix: Fix,
  decision: Decision,
  target: FixTarget,
  tree: string,
  branch: string,
  context: ActContext,
  git: (args: string[], cwd: string, timeoutMs?: number) => ReturnType<Exec>,
): Promise<{ ok: true; checked: string[] } | { ok: false; detail: string }> {
  const proposal = await askGuard(
    proposalReviewerPrompt({
      target: target.name,
      title: fix.title,
      instruction: fix.instruction,
      conformity: fix.conformity,
      rules: target.rules,
    }),
    "proposal",
    tree,
    context,
    true,
  );
  if (proposal.kind === "unavailable") {
    return { ok: false, detail: `the guard could not judge the proposal: ${proposal.reason}` };
  }
  if (proposal.kind === "reject") {
    return {
      ok: false,
      detail: `the guard refused the proposal before it was written:\n${proposal.reasons.map((r) => `- ${r}`).join("\n")}`,
    };
  }
  let failure: string | undefined;
  let lastPoints: number[] = [];
  for (let round = 1; round <= FIX_ROUNDS; round++) {
    const agent = await runAgent({
      config: context.config,
      exec: context.exec,
      role: "fixer",
      prompt: fixerPrompt({
        target: target.name,
        title: fix.title,
        instruction: fix.instruction,
        conformity: fix.conformity,
        deferred: proposal.deferred,
        cause: decision.cause,
        evidence: decision.evidence,
        deny: target.deny,
        checks: target.checks.map((check) => check.cmd.join(" ")),
        ...(failure === undefined ? {} : { failure }),
      }),
      dir: join(context.dir, `fix-${round}`),
      cwd: tree,
      addDirs: [],
    });
    if (!agent.ok) {
      failure = `The agent itself failed: ${agent.text.slice(0, 1500)}`;
      continue;
    }
    const status = await git(["status", "--porcelain"], tree);
    const changed = status.stdout
      .split("\n")
      .filter((line) => line.length > 3)
      .map((line) => line.slice(3).replace(/^"|"$/g, ""));
    if (changed.length === 0) {
      failure =
        "You changed nothing. If the cause is not what was described, change what is actually wrong.";
      continue;
    }
    const denied = changed.filter((path) => target.deny.some((prefix) => path.startsWith(prefix)));
    if (denied.length > 0) {
      failure = `You touched paths you may not: ${denied.join(", ")}. Revert them.`;
      continue;
    }
    failure = undefined;
    for (const check of target.checks) {
      const result = await context.exec(check.cmd, { cwd: tree, timeoutMs: check.timeoutMs });
      if (!succeeded(result)) {
        failure = `\`${check.cmd.join(" ")}\` failed:\n${tail(result)}`;
        break;
      }
    }
    if (failure === undefined) {
      const staged = await git(["add", "-A"], tree);
      if (!succeeded(staged)) {
        return { ok: false, detail: `add: ${tail(staged)}` };
      }
      const guard = await review(fix, target, tree, context, git);
      if (guard.kind === "unavailable") {
        return { ok: false, detail: `the guard could not give a verdict: ${guard.reason}` };
      }
      if (guard.kind === "reject") {
        const again = guard.points.filter((point) => lastPoints.includes(point));
        if (again.length > 0) {
          return {
            ok: false,
            detail: `stopped: the guard rejected point ${[...new Set(again)].join(", ")} twice in a row, so another round would repeat it. A person decides:\n${guard.reasons.map((r) => `- ${r}`).join("\n")}`,
          };
        }
        lastPoints = guard.points;
        failure = `The guard rejected the change:\n${guard.reasons.map((r) => `- ${r}`).join("\n")}`;
        continue;
      }
      const done = await git(
        ["commit", "-m", `${fix.title}\n\nMade by the ${PRODUCT} supervisor (${branch}).`],
        tree,
      );
      return succeeded(done)
        ? { ok: true, checked: guard.checked }
        : { ok: false, detail: `commit: ${tail(done)}` };
    }
  }
  return { ok: false, detail: `no passing change after ${FIX_ROUNDS} rounds: ${failure ?? ""}` };
}

type Guard =
  | { kind: "approve"; checked: string[]; deferred: string[] }
  | { kind: "reject"; reasons: string[]; points: number[] }
  | { kind: "unavailable"; reason: string };

/** The guard reads the change and the repository, not the stop. Asked twice if it answers badly. */
async function review(
  fix: Fix,
  target: FixTarget,
  tree: string,
  context: ActContext,
  git: (args: string[], cwd: string, timeoutMs?: number) => ReturnType<Exec>,
): Promise<Guard> {
  const files = (await git(["diff", "--cached", "--name-only"], tree)).stdout
    .split("\n")
    .filter((line) => line.length > 0);
  const full = (await git(["diff", "--cached"], tree)).stdout;
  const diff =
    full.length > DIFF_CHARS
      ? `${full.slice(0, DIFF_CHARS)}\n[diff cut: read the rest in the tree]`
      : full;
  return await askGuard(
    reviewerPrompt({
      target: target.name,
      title: fix.title,
      files,
      diff,
      checks: target.checks.map((check) => check.cmd.join(" ")),
    }),
    "review",
    tree,
    context,
  );
}

/** Ask the guard once, again if it answers badly. `label` names the folder its files go to. */
async function askGuard(
  prompt: string,
  label: string,
  tree: string,
  context: ActContext,
  proposal = false,
): Promise<Guard> {
  let reason = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const answer = await runAgent({
      config: context.config,
      exec: context.exec,
      role: "reviewer",
      prompt:
        attempt === 1
          ? prompt
          : `${prompt}\n\nYour previous answer was refused: ${reason}. Answer again.`,
      dir: join(context.dir, `${label}-${attempt}`),
      cwd: tree,
      addDirs: [],
    });
    if (!answer.ok) {
      reason = `the agent failed: ${answer.text.slice(0, 500)}`;
      continue;
    }
    const verdict = parseVerdict(answer.text, { proposal });
    if (!verdict.ok) {
      reason = verdict.reason;
      continue;
    }
    return verdict.approve
      ? { kind: "approve", checked: verdict.checked, deferred: verdict.deferred }
      : { kind: "reject", reasons: verdict.reasons, points: verdict.points };
  }
  return { kind: "unavailable", reason };
}

async function waitFolded(
  target: FixTarget,
  pr: string,
  cwd: string,
  context: ActContext,
): Promise<boolean> {
  const sleep =
    context.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  for (let waited = 0; waited <= FOLD_WAIT_MS; waited += FOLD_POLL_MS) {
    const result = await context.exec(fill(target.merged.cmd, { pr }), {
      cwd,
      timeoutMs: target.merged.timeoutMs,
    });
    if (succeeded(result)) {
      return true;
    }
    await sleep(FOLD_POLL_MS);
  }
  return false;
}
