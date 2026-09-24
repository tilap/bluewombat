import { existsSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import type { Finding, ManagerModule } from "@bluewombat/manager-kit";
import { PRODUCT } from "@bluewombat/manager-kit";
import { ISOLATION_COPY, ISOLATION_GIT } from "../config/defaults.js";
import { CONFIG_FILENAME, findConfig } from "../config/find-config.js";
import { parseArgs } from "../config/parse-args.js";
import type { HostInvocation } from "../config/types.js";
import { inspectWorkLine, resolveWorkLine, type WorkLineResolution } from "../loop/work-line.js";
import { resolveIsolationStrategy } from "../plugins/isolation.js";
import { contextOf, loadManagerModule } from "../plugins/manager.js";
import { remoteNames } from "./git-remote.js";

export type DoctorInput = {
  cwd: string;
  argv: string[];
  env: Record<string, string | undefined>;
  write: (line: string) => void;
  /** Defaults to the running one. Named so the check itself stays testable. */
  nodeVersion?: string;
};

const REQUIRED_NODE_MAJOR = 24;

/**
 * Say what is missing before a run says it. Nothing here uses the network:
 * the answer must be the same offline, and a manager's own check is held to
 * the same rule.
 */
export async function runDoctor(input: DoctorInput): Promise<number> {
  const findings: Finding[] = [nodeFinding(input.nodeVersion ?? process.versions.node)];

  const configPath = configPathOf(input);
  findings.push(
    configPath === undefined
      ? { level: "warn", label: "config", detail: `no ${CONFIG_FILENAME} found; using flags only` }
      : { level: "ok", label: "config", detail: configPath },
  );

  const parsed = parseArgs(input.argv, { cwd: input.cwd, checkPaths: false });
  if (!parsed.ok) {
    findings.push({ level: "fail", label: "invocation", detail: parsed.reason });
    return report(findings, input.write);
  }
  const invocation = parsed.invocation;
  findings.push({ level: "ok", label: "invocation", detail: "every required field is set" });
  findings.push({ level: "ok", label: "home", detail: invocation.home });

  const request = {
    manager: invocation.manager,
    managerOptions: invocation.managerOptions,
    configDir: invocation.configDir,
    durationMs: invocation.timeoutMs,
    interruptFlag: { interrupted: false },
    env: input.env,
  };
  const loaded = await loadManagerModule(request);
  const workLine = await workLineOf(invocation, loaded.ok ? loaded.module : undefined);
  findings.push(...workLineFindings(workLine));
  // Whose the directory is decides which checks apply: Host's copy of a
  // reference was already held against it, and may not exist yet.
  const stable = workLine.kind === "invalid" ? undefined : workLine.stable;
  const target = workLine.kind === "copy" ? workLine.target : invocation.workLineBranch;
  findings.push(...isolationFindings(invocation, workLine));
  findings.push(...authorityFindings(invocation, workLine, target, input.env));
  const judged = assemblyFinding(invocation);
  if (judged !== undefined) {
    findings.push(judged);
  }
  if (stable !== undefined && workLine.kind !== "copy") {
    const onBranch = workLineBranchFinding(stable, target);
    if (onBranch !== undefined) {
      findings.push(onBranch);
    }
  }
  findings.push(writableFinding("workspace root", invocation.workspaceRoot));
  findings.push(writableFinding("ledger root", invocation.ledgerRoot));
  // What a stream holds is the Project's own material in the clear, so whether
  // it is being written is something an operator should be able to ask.
  const streams = invocation.observability?.streams;
  findings.push(
    streams?.enabled === true
      ? {
          level: "ok",
          label: "streams",
          detail: `${streams.dir ?? join(invocation.home, "streams")} (${(streams.keep ?? ["stdout", "stderr"]).join(", ")})`,
        }
      : { level: "ok", label: "streams", detail: "off — the journal alone" },
  );
  findings.push(commandFinding("Planner", invocation.planner.cmd, input.env));
  for (const stage of ["builder", "assembly"] as const) {
    if (stage === "builder") {
      for (const pass of ["producer", "repair"] as const) {
        findings.push(
          commandFinding(`${label(stage)} ${pass}`, invocation.builder[pass].cmd, input.env),
        );
      }
    } else if (invocation.assembly.fix !== undefined) {
      findings.push(commandFinding("Assembly fix", invocation.assembly.fix.cmd, input.env));
    }
    for (const gate of invocation[stage].gates) {
      findings.push(commandFinding(`${label(stage)} gate ${gate.id}`, gate.argv, input.env));
    }
  }
  findings.push(...assemblyFixFindings(invocation));

  if (!loaded.ok) {
    findings.push({ level: "fail", label: "manager", detail: loaded.reason });
    return report(findings, input.write);
  }
  findings.push({ level: "ok", label: "manager", detail: invocation.manager });
  if (loaded.module.checkManager !== undefined) {
    findings.push(...(await loaded.module.checkManager(contextOf(request))));
  }
  return report(findings, input.write);
}

/**
 * Whether the Project offers its work to somebody outside, and how.
 *
 * The block is a declaration, so this is where the declaration meets reality:
 * an Authority needs a work line to offer the work to, and a command that puts
 * the work in front of it.
 */
function authorityFindings(
  invocation: HostInvocation,
  workLine: WorkLineResolution,
  target: string | undefined,
  env: Record<string, string | undefined>,
): Finding[] {
  const authority = invocation.authority;
  if (authority === undefined) {
    return [
      {
        level: "warn",
        label: "authority",
        detail:
          'not declared — the fold is local and final. Add "authority": { "enabled": false } to say so, or true to offer the work',
      },
    ];
  }
  if (!authority.enabled) {
    return [
      { level: "ok", label: "authority", detail: "none — the fold into WorkLineStable is final" },
    ];
  }
  const findings: Finding[] = [];
  if (target === undefined) {
    findings.push({
      level: "fail",
      label: "authority",
      detail: 'enabled, but "workLine.branch" does not say which work line the work is offered to',
    });
  } else {
    findings.push({
      level: "ok",
      label: "authority",
      detail: `offers the assembled feature on "${target}"`,
    });
  }
  findings.push(commandFinding("Publisher", authority.publishArgv, env));
  findings.push(commandFinding("Refresher", authority.refreshArgv, env));
  if (authority.describeArgv !== undefined) {
    findings.push(commandFinding("Describer", authority.describeArgv, env));
  }
  // An accepted Submission moves the work line where the Authority is, and Host
  // reads that back from `origin` before the next Isolation. Without that
  // remote the fetch fails on every tick and the run starts nothing at all —
  // silently, because a skipped tick looks exactly like an idle one. A copy of
  // a reference has its `origin` by construction.
  if (
    target !== undefined &&
    (workLine.kind === "operators" || workLine.kind === "unchecked") &&
    inspectWorkLine(workLine.stable).kind === "git" &&
    !remoteNames(workLine.stable).includes("origin")
  ) {
    findings.push({
      level: "fail",
      label: "work line remote",
      detail:
        'no "origin" — after the Authority folds, Host reads the work line back from it, and every run would start nothing until it exists',
    });
  }
  return findings;
}

function configPathOf(input: DoctorInput): string | undefined {
  const flagged = input.argv.indexOf("--config");
  if (flagged >= 0) {
    return input.argv[flagged + 1];
  }
  return findConfig(input.cwd);
}

function nodeFinding(version: string): Finding {
  const major = Number(version.split(".")[0]);
  return major >= REQUIRED_NODE_MAJOR
    ? { level: "ok", label: "Node.js", detail: version }
    : {
        level: "fail",
        label: "Node.js",
        detail: `${version} — ${PRODUCT} needs ${REQUIRED_NODE_MAJOR} or later`,
      };
}

/**
 * The same decision `mason run` makes at boot, without the fetch. A manager
 * that does not load names no reference; the failure is reported where the
 * manager is.
 */
async function workLineOf(
  invocation: HostInvocation,
  module: ManagerModule | undefined,
): Promise<WorkLineResolution> {
  const strategy = await resolveIsolationStrategy(
    invocation.workLineIsolation,
    invocation.configDir,
    invocation.workLineIsolationOptions,
  );
  if (!strategy.ok) {
    return { kind: "invalid", reason: strategy.reason };
  }
  const context = contextOf({
    manager: invocation.manager,
    managerOptions: invocation.managerOptions,
    configDir: invocation.configDir,
    durationMs: invocation.timeoutMs,
    interruptFlag: { interrupted: false },
    env: {},
  });
  return resolveWorkLine({
    home: invocation.home,
    stable: invocation.workLineStable,
    branch: invocation.workLineBranch,
    manager: invocation.manager,
    wantsAuthority: invocation.authority?.enabled === true,
    reference: module?.referenceManager?.(context),
    strategy: strategy.strategy,
    strategyName: strategy.specifier,
  });
}

function workLineFindings(workLine: WorkLineResolution): Finding[] {
  switch (workLine.kind) {
    case "invalid":
      return [{ level: "fail", label: "work line", detail: workLine.reason }];
    case "operators":
      return [workLineFinding(workLine.stable)];
    case "unchecked":
      return [
        workLineFinding(workLine.stable),
        { level: "warn", label: "work line", detail: `${workLine.reason} Taken as is.` },
      ];
    case "copy": {
      const findings: Finding[] = [
        { level: "ok", label: "reference", detail: workLine.reference.summary },
      ];
      switch (workLine.state.kind) {
        case "matches":
          findings.push({ level: "ok", label: "work line", detail: `${workLine.stable} (copy)` });
          break;
        case "missing":
          findings.push({
            level: "ok",
            label: "work line",
            detail: `${workLine.stable} — copied from the reference on the first run`,
          });
          break;
        case "mismatch":
          findings.push({
            level: "fail",
            label: "work line",
            detail: `${workLine.stable} is not a copy of the reference: ${workLine.state.reason}`,
          });
          break;
      }
      return findings;
    }
  }
}

function workLineFinding(path: string): Finding {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    return { level: "fail", label: "WorkLineStable", detail: `not a directory: ${path}` };
  }
  if (!existsSync(join(path, ".git"))) {
    return {
      level: "ok",
      label: "WorkLineStable",
      detail: `${path} (plain directory)`,
    };
  }
  return { level: "ok", label: "WorkLineStable", detail: `${path} (git)` };
}

/**
 * Whether `workLine.isolation` matches what is on disk, and what Authority needs.
 *
 * Isolator does not choose a strategy; the config does. A mismatch here is a Project that will
 * fail on the first Isolation, or one that cannot publish a Submission.
 */
function isolationFindings(invocation: HostInvocation, workLine: WorkLineResolution): Finding[] {
  const findings: Finding[] = [
    {
      level: "ok",
      label: "workLine.isolation",
      detail: invocation.workLineIsolation,
    },
  ];
  const isGitStrategy = invocation.workLineIsolation === ISOLATION_GIT;
  const isCopyStrategy = invocation.workLineIsolation === ISOLATION_COPY;
  // A copy of a reference is git by construction, fetched or not yet.
  const operatorsTree =
    workLine.kind === "operators" || workLine.kind === "unchecked"
      ? inspectWorkLine(workLine.stable)
      : undefined;
  if (isGitStrategy && operatorsTree !== undefined && operatorsTree.kind !== "git") {
    findings.push({
      level: "warn",
      label: "workLine.isolation",
      detail: `"${ISOLATION_GIT}", but WorkLineStable has no .git — the first Isolation will fail until the directory is a git tree`,
    });
  }
  if (isCopyStrategy && invocation.authority?.enabled === true) {
    findings.push({
      level: "warn",
      label: "workLine.isolation",
      detail: `"${ISOLATION_COPY}" with authority.enabled — the git Publisher needs a git work line; Submissions will refuse`,
    });
  }
  return findings;
}

/**
 * Whether anything judges the assembled feature.
 *
 * With a work line to offer the work to, the assembled feature is published and
 * then folded on the Gate sequence's word. An empty sequence is a Project that
 * publishes and merges with nothing looking at the whole.
 */
function assemblyFinding(invocation: HostInvocation): Finding | undefined {
  // Only an Authority publishes and merges. With the fold staying local there
  // is nothing outside to guard, and the unit Gates already judged every part.
  if (invocation.authority?.enabled !== true) {
    return undefined;
  }
  if (invocation.assembly.gates.length > 0) {
    return {
      level: "ok",
      label: "assembly gates",
      detail: invocation.assembly.gates.map((gate) => gate.id).join(", "),
    };
  }
  return {
    level: "warn",
    label: "assembly gates",
    detail:
      'none — the assembled feature is published and merged with nothing judging it. Add "assembly.gates" (ci-green reads the work line\'s own checks)',
  };
}

function label(stage: "builder" | "assembly"): string {
  return stage === "builder" ? "Builder" : "Assembly";
}

/**
 * A Submission that comes back needs a command that can fix what the judgement
 * named. Nothing sends one back where no Authority ever took it.
 */
function assemblyFixFindings(invocation: HostInvocation): Finding[] {
  const declared = invocation.assembly.fix !== undefined;
  const offering = invocation.authority?.enabled === true;
  if (offering && !declared) {
    return [
      {
        level: "fail",
        label: "assembly fix",
        detail: 'authority.enabled is true, so a Submission can come back. Name "assembly.fix"',
      },
    ];
  }
  if (declared && !offering) {
    return [
      {
        level: "warn",
        label: "assembly fix",
        detail:
          "declared, but nothing sends a Submission back without an Authority — it will never run",
      },
    ];
  }
  return [];
}

/**
 * Which work line a fold would land on.
 *
 * Without `workLine.branch` the answer is "whatever is checked out", which is
 * nobody's decision: leave that tree on another branch and a feature lands
 * there without a word.
 */
function workLineBranchFinding(path: string, wanted: string | undefined): Finding | undefined {
  const state = inspectWorkLine(path);
  if (state.kind !== "git") {
    return undefined;
  }
  if (wanted === undefined) {
    return {
      level: "warn",
      label: "work line",
      detail: `on "${state.branch}" — set "workLine.branch" to say which one a fold must land on`,
    };
  }
  if (state.branch !== wanted) {
    return {
      level: "fail",
      label: "work line",
      detail: `on "${state.branch}", but the config wants "${wanted}"`,
    };
  }
  return { level: "ok", label: "work line", detail: wanted };
}

/** Host creates the whole chain, so the nearest existing ancestor is the answer. */
function writableFinding(label: string, path: string): Finding {
  if (existsSync(path)) {
    return statSync(path).isDirectory()
      ? { level: "ok", label, detail: path }
      : { level: "fail", label, detail: `not a directory: ${path}` };
  }
  let ancestor = dirname(path);
  for (;;) {
    if (existsSync(ancestor)) {
      return statSync(ancestor).isDirectory()
        ? { level: "ok", label, detail: `${path} (created on run)` }
        : { level: "fail", label, detail: `not a directory: ${ancestor}` };
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) {
      return { level: "fail", label, detail: `no existing parent for ${path}` };
    }
    ancestor = parent;
  }
}

function commandFinding(
  label: string,
  argv: string[],
  env: Record<string, string | undefined>,
): Finding {
  const command = argv[0];
  if (command === undefined) {
    return { level: "fail", label, detail: "empty command" };
  }
  return locate(command, env) === undefined
    ? { level: "fail", label, detail: `command not found: ${command}` }
    : { level: "ok", label, detail: argv.join(" ") };
}

/** An explicit path must exist; a bare word must sit on PATH. */
function locate(command: string, env: Record<string, string | undefined>): string | undefined {
  if (isAbsolute(command) || command.includes("/")) {
    return existsSync(command) ? command : undefined;
  }
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir.length > 0 && existsSync(join(dir, command))) {
      return join(dir, command);
    }
  }
  return undefined;
}

function report(findings: Finding[], write: (line: string) => void): number {
  let failed = 0;
  for (const finding of findings) {
    if (finding.level === "fail") {
      failed += 1;
    }
    const mark = finding.level === "ok" ? "ok  " : finding.level === "warn" ? "warn" : "FAIL";
    write(
      `${mark}  ${finding.label}${finding.detail === undefined ? "" : ` — ${finding.detail}`}\n`,
    );
  }
  write(failed === 0 ? "\nReady to run.\n" : `\n${failed} check(s) failed.\n`);
  return failed === 0 ? 0 : 1;
}
