import { existsSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ManagerQuestion, ManagerScaffold } from "@bluewombat/manager-kit";
import { PRODUCT } from "@bluewombat/manager-kit";
import { stringify as stringifyYaml } from "yaml";
import { BOOTSTRAP_PLANNER, ISOLATION_COPY, ISOLATION_GIT } from "../config/defaults.js";
import { CONFIG_FILENAME } from "../config/find-config.js";
import { DEFAULT_HOME, inHome } from "../config/home.js";
import { inspectWorkLine } from "../loop/work-line.js";
import { type DiscoveredManager, discoverManagers } from "../plugins/discover.js";
import { contextOf, loadManagerModule } from "../plugins/manager.js";
import { cloneWorkLine, remoteBranches, remoteHead } from "./git-remote.js";
import { type Ask, askChoice, askText, askYesNo, PromptAbandoned } from "./prompt.js";
import { runSetup } from "./setup.js";

export type InitInput = {
  cwd: string;
  argv: string[];
  write: (line: string) => void;
  env?: Record<string, string | undefined>;
  /** Present: the wizard runs and asks. Absent: flags only, nothing is asked. */
  ask?: Ask;
};

export type InitResult =
  | { ok: true; path: string; exitCode: number }
  | { ok: false; reason: string; exitCode?: number };

const BUILDER_FILENAME = `${PRODUCT}-builder.mjs`;
const DEFAULT_WORK_LINE = "./work-line-stable";
const DURATION_MS = 600_000;
/** A producer's ceiling. Required, so `init` writes one rather than leaving it out. */
const BUILDER_TIMEOUT_MS = 600_000;
/** What a Gate takes when it names none of its own. */
const GATE_TIMEOUT_MS = 120_000;

const PLANNER_IN_PROJECT = `./node_modules/${BOOTSTRAP_PLANNER}`;

const BUILDER_STUB = `#!/usr/bin/env node
// The Builder slot. ${PRODUCT} spawns it in the Subtask workspace with --id,
// --attempt, --intention and --definition-of-done, and reads the exit code:
// 0 means the Gates may run. Replace it with your producer — an agent CLI,
// a script, anything that writes the work into the current directory.
// Leave that work uncommitted: it is what the Gates read and what ${PRODUCT} folds.
process.stderr.write("${PRODUCT}: no Builder yet. Edit ${BUILDER_FILENAME}.\\n");
process.exit(1);
`;

/**
 * Set a working directory up, in one pass.
 *
 * With `ask`, it walks the questions — which manager, what that manager needs,
 * where WorkLineStable is — then writes the files and carries straight on into
 * `setup`, so nothing has to be re-run by hand. With flags only, it writes the
 * same files and asks nothing, which is what a script wants.
 */
export async function runInit(input: InitInput): Promise<InitResult> {
  try {
    return await init(input);
  } catch (error) {
    if (error instanceof PromptAbandoned) {
      return { ok: false, reason: error.message, exitCode: 130 };
    }
    throw error;
  }
}

async function init(input: InitInput): Promise<InitResult> {
  const flags = parseInitFlags(input.argv, input.ask !== undefined);
  if (!flags.ok) {
    return flags;
  }
  const path = resolve(input.cwd, CONFIG_FILENAME);
  const env = input.env ?? {};

  if (existsSync(path) && !flags.force) {
    if (input.ask === undefined) {
      return { ok: false, reason: `${CONFIG_FILENAME} already exists. Pass --force to overwrite.` };
    }
    input.write(`${CONFIG_FILENAME} already exists here.\n`);
    if (!(await askYesNo(input.ask, "Overwrite it?", false, input.write))) {
      return { ok: false, reason: "Left the existing config alone.", exitCode: 0 };
    }
  }

  const manager = await chooseManager(input, flags.manager);
  if (manager.ok === false) {
    return manager;
  }

  const request = {
    manager: manager.name,
    managerOptions: flags.managerOptions,
    configDir: input.cwd,
    durationMs: DURATION_MS,
    interruptFlag: { interrupted: false },
    env,
  };
  const loaded = await loadManagerModule(request);
  if (!loaded.ok && input.ask !== undefined) {
    return {
      ok: false,
      reason: `${manager.name} is not installed here. Run: npm install ${manager.name}`,
    };
  }

  let scaffold: ManagerScaffold = loaded.ok
    ? { options: {}, nextSteps: [] }
    : { options: {}, nextSteps: [`npm install ${manager.name}`] };
  if (loaded.ok && loaded.module.scaffoldManager !== undefined) {
    scaffold = await loaded.module.scaffoldManager(contextOf(request));
  }

  let questions: ManagerQuestion[] = [];
  if (loaded.ok && loaded.module.questionsManager !== undefined) {
    questions = await loaded.module.questionsManager(
      contextOf({ ...request, managerOptions: { ...scaffold.options, ...flags.managerOptions } }),
    );
  }
  // A flag goes through the same reader the question would have used, so
  // `--manager-option labels=mason` and the typed answer land as one shape,
  // and a malformed one is refused here rather than at the first run.
  const fromFlags = readFlagOptions(questions, flags.managerOptions);
  if (fromFlags.ok === false) {
    return fromFlags;
  }

  let managerOptions = { ...scaffold.options, ...fromFlags.options };
  if (input.ask !== undefined) {
    // Only a flag silences a question. A scaffold value is a default for the
    // keys nobody asks about, not an answer already given.
    const answered = await askQuestions(input.ask, input.write, questions, flags.managerOptions);
    managerOptions = { ...scaffold.options, ...answered, ...fromFlags.options };
    // Asked again with the answers in hand, so its next steps do not still
    // demand what was just typed in.
    if (loaded.ok && loaded.module.scaffoldManager !== undefined) {
      scaffold = await loaded.module.scaffoldManager(contextOf({ ...request, managerOptions }));
      managerOptions = { ...scaffold.options, ...answered, ...fromFlags.options };
    }
  }

  // A manager that names a reference work line leaves nothing to ask: Host
  // keeps its own copy, fetched on the first run. Only a manager with none
  // makes the directory the operator's to choose and to fill.
  const reference =
    loaded.ok && loaded.module.referenceManager !== undefined
      ? loaded.module.referenceManager(contextOf({ ...request, managerOptions }))
      : undefined;
  let workLine: { stable?: string; isolation: string };
  if (reference !== undefined) {
    workLine = { isolation: ISOLATION_GIT };
    input.write(
      `  Work line: ${manager.name} names the reference; Host keeps a copy under ${inHome(DEFAULT_HOME, "workLine")}\n`,
    );
  } else {
    const chosen = await chooseWorkLine(input, flags);
    if (chosen.ok === false) {
      return chosen;
    }
    const workLineState = inspectWorkLine(resolve(input.cwd, chosen.path));
    workLine = {
      stable: chosen.path,
      isolation: workLineState.kind === "git" ? ISOLATION_GIT : ISOLATION_COPY,
    };
  }

  const config = {
    manager: manager.name,
    managerOptions,
    workLine,
    // No `home`, `workspaceRoot` or `ledger`: the defaults put all of it under
    // `.mason`, and a key that repeats a default is one more thing to keep true.
    planner: { cmd: ["node", plannerPath(input.cwd)], timeoutMs: DURATION_MS },
    // Both passes name the same stub, and both are written out: a repair runs
    // its own agent or it runs nothing, never the first pass by default. Each
    // carries its own Gate sequence — a repair with none of its own runs
    // ungated, even once the producer's is filled in.
    builder: {
      producer: {
        cmd: ["node", `./${BUILDER_FILENAME}`],
        timeoutMs: BUILDER_TIMEOUT_MS,
        gates: { defaultTimeoutMs: GATE_TIMEOUT_MS, gates: [] },
      },
      repair: {
        cmd: ["node", `./${BUILDER_FILENAME}`],
        timeoutMs: BUILDER_TIMEOUT_MS,
        gates: { defaultTimeoutMs: GATE_TIMEOUT_MS, gates: [] },
      },
      maxAttempts: 3,
    },
    // No fix here: that command only runs on a Submission an Authority sent
    // back, and this Project offers nothing yet.
    assembly: { gates: { defaultTimeoutMs: GATE_TIMEOUT_MS, gates: [] } },
    authority: { enabled: false },
    timeoutMs: DURATION_MS,
    pollIntervalMs: 30_000,
  };
  writeFileSync(path, stringifyYaml(config, { lineWidth: 0 }), "utf8");

  const builderPath = resolve(input.cwd, BUILDER_FILENAME);
  if (!existsSync(builderPath)) {
    writeFileSync(builderPath, BUILDER_STUB, { encoding: "utf8", mode: 0o755 });
  }
  scaffold.prepare?.(input.cwd);
  input.write(`\nWrote ${CONFIG_FILENAME} and ${BUILDER_FILENAME}.\n`);

  const exitCode = await carryOnIntoSetup(
    input,
    loaded.ok && loaded.module.setupManager !== undefined,
  );

  input.write("\nStill yours to write:\n");
  for (const step of [...scaffold.nextSteps, ...hostNextSteps()]) {
    input.write(`  - ${step}\n`);
  }
  input.write(`\nThen: ${PRODUCT} doctor, and ${PRODUCT} run\n`);
  return { ok: true, path, exitCode };
}

/**
 * `setup` right here beats telling somebody to run it next.
 *
 * A plan never decides this command's exit code: `init` wrote its files, and
 * `mason init && mason setup --apply` must not stop because a token is not
 * exported yet. Only a failed *apply* is reported as a failure.
 */
async function carryOnIntoSetup(input: InitInput, hasSetup: boolean): Promise<number> {
  if (!hasSetup) {
    return 0;
  }
  input.write("\nChecking what the tracker still needs.\n\n");
  const plan = await runSetup({
    cwd: input.cwd,
    argv: [],
    env: input.env ?? {},
    write: input.write,
  });
  if (input.ask === undefined || plan !== 0) {
    return 0;
  }
  if (!(await askYesNo(input.ask, "\nApply those steps now?", true, input.write))) {
    return 0;
  }
  input.write("\n");
  return await runSetup({
    cwd: input.cwd,
    argv: ["--apply"],
    env: input.env ?? {},
    write: input.write,
  });
}

type Chosen = { ok: true; name: string } | { ok: false; reason: string };

async function chooseManager(input: InitInput, named: string): Promise<Chosen> {
  if (named.length > 0) {
    return { ok: true, name: named };
  }
  if (input.ask === undefined) {
    return { ok: false, reason: "Missing --manager. Name a package that exports createManager." };
  }
  const installed = discoverManagers(input.cwd);
  if (installed.length === 0) {
    return {
      ok: false,
      reason:
        "No FeatureManager package is installed here.\n" +
        `Install one, then run ${PRODUCT} init again — for GitHub Issues:\n` +
        "  npm install @bluewombat/manager-github",
    };
  }
  const only = installed[0];
  if (installed.length === 1 && only !== undefined) {
    // Picking it silently reads as "this tool only does GitHub". One keypress
    // says which tracker is about to ask the questions, and leaves a way out.
    input.write(`Manager: ${only.name}\n`);
    if (only.description !== undefined) {
      input.write(`  ${only.description}\n`);
    }
    if (await askYesNo(input.ask, "Use it?", true, input.write)) {
      return { ok: true, name: only.name };
    }
    const typed = await askText(input.ask, "Manager package", {
      required: true,
      write: input.write,
    });
    return typed.length === 0
      ? { ok: false, reason: "No manager chosen." }
      : { ok: true, name: typed };
  }
  input.write("Which FeatureManager?\n");
  const index = await askChoice(input.ask, input.write, "Manager", installed.map(describe));
  const picked = installed[index];
  return picked === undefined
    ? { ok: false, reason: "No manager chosen." }
    : { ok: true, name: picked.name };
}

function describe(entry: DiscoveredManager): string {
  return entry.description === undefined ? entry.name : `${entry.name} — ${entry.description}`;
}

/**
 * Run each question's own reader over the value its key was given as a flag.
 * A key with no question, or a value that arrived as an array from a repeated
 * flag, is passed through untouched.
 */
function readFlagOptions(
  questions: ManagerQuestion[],
  given: Record<string, unknown>,
): { ok: true; options: Record<string, unknown> } | { ok: false; reason: string } {
  const options: Record<string, unknown> = { ...given };
  for (const question of questions) {
    const value = options[question.key];
    if (question.parse === undefined || typeof value !== "string") {
      continue;
    }
    const parsed = question.parse(value);
    if (!parsed.ok) {
      return { ok: false, reason: `--manager-option ${question.key}: ${parsed.reason}` };
    }
    options[question.key] = parsed.value;
  }
  return { ok: true, options };
}

/** `given` holds the flags: a key already passed there is not asked about. */
async function askQuestions(
  ask: Ask,
  write: (line: string) => void,
  questions: ManagerQuestion[],
  given: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const answers: Record<string, unknown> = {};
  for (const question of questions) {
    // A value already given on the command line is not asked for again.
    if (given[question.key] !== undefined) {
      continue;
    }
    for (let tries = 0; tries < 3; tries += 1) {
      const options: { fallback?: string; required?: boolean } = {};
      if (question.fallback !== undefined) {
        options.fallback = question.fallback;
      }
      if (question.required !== undefined) {
        options.required = question.required;
      }
      const answer = await askText(ask, question.prompt, options);
      if (answer.length === 0) {
        break;
      }
      if (question.parse === undefined) {
        answers[question.key] = answer;
        break;
      }
      const parsed = question.parse(answer);
      if (parsed.ok) {
        answers[question.key] = parsed.value;
        break;
      }
      write(`  ${parsed.reason}\n`);
    }
  }
  return answers;
}

type ChosenWorkLine = { ok: true; path: string } | { ok: false; reason: string };

/**
 * WorkLineStable must exist before a run: nothing downstream creates it. The
 * wizard may clone it, but only after the branch has been shown to exist.
 */
async function chooseWorkLine(input: InitInput, flags: InitFlags): Promise<ChosenWorkLine> {
  const fallback = flags.workLineStable ?? DEFAULT_WORK_LINE;
  const chosen =
    input.ask === undefined
      ? fallback
      : await askText(input.ask, `Directory ${PRODUCT} folds the work into`, { fallback });
  const absolute = resolve(input.cwd, chosen);
  const state = inspectWorkLine(absolute);
  const say = input.ask === undefined ? () => {} : input.write;

  if (state.kind === "not-a-directory") {
    return { ok: false, reason: `${absolute} exists and is not a directory.` };
  }
  if (state.kind === "git") {
    say(`  ${absolute} — git, on branch ${state.branch}\n`);
    return { ok: true, path: chosen };
  }
  if (state.kind === "plain") {
    say(`  ${absolute} — no .git, so the work is folded in by copy, not by merge\n`);
    return { ok: true, path: chosen };
  }

  // Missing. `--clone` answers for the wizard's question too, so a script and a
  // session reach the same place by the same code.
  if (flags.clone !== undefined) {
    const cloned = cloneChecked(input, flags.clone, flags.branch, absolute);
    return cloned.ok ? { ok: true, path: chosen } : cloned;
  }
  if (input.ask === undefined) {
    return { ok: true, path: chosen };
  }

  input.write(`  ${absolute} does not exist yet.\n`);
  if (!(await askYesNo(input.ask, "  Clone it from a git remote?", true, input.write))) {
    input.write(`  Create it before running ${PRODUCT}.\n`);
    return { ok: true, path: chosen };
  }
  const cloned = await cloneAsked(input, absolute);
  return cloned.ok ? { ok: true, path: chosen } : cloned;
}

/**
 * Clone, having first shown that the branch is really there.
 *
 * A `git clone --branch` that misses fails with a message about a repository,
 * not about the name that was wrong — so the branch is checked separately and
 * the alternatives are listed.
 */
function cloneChecked(
  input: InitInput,
  remote: string,
  branch: string | undefined,
  absolute: string,
): ChosenWorkLine {
  const listed = remoteBranches(remote);
  if (!listed.ok) {
    return { ok: false, reason: listed.reason };
  }
  if (listed.names.length === 0) {
    return { ok: false, reason: `${remote} has no branches.` };
  }
  const wanted = branch ?? remoteHead(remote);
  if (wanted === undefined) {
    return {
      ok: false,
      reason: `${remote} has no default branch. Name one with --branch. It has: ${listed.names.join(", ")}`,
    };
  }
  if (!listed.names.includes(wanted)) {
    return {
      ok: false,
      reason: `${remote} has no branch "${wanted}". It has: ${listed.names.join(", ")}`,
    };
  }
  const cloned = cloneWorkLine(remote, wanted, absolute);
  if (!cloned.ok) {
    return { ok: false, reason: cloned.reason };
  }
  input.write(`  Cloned ${remote} (${wanted}) into ${absolute}\n`);
  return { ok: true, path: absolute };
}

async function cloneAsked(input: InitInput, absolute: string): Promise<ChosenWorkLine> {
  const ask = input.ask;
  if (ask === undefined) {
    return { ok: true, path: absolute };
  }
  // Empty means "I will put it there myself" — not a reason to abandon init.
  const remote = await askText(ask, "  Git remote (empty to skip)");
  if (remote.length === 0) {
    input.write(`  Skipped. Create ${absolute} before running ${PRODUCT}.\n`);
    return { ok: true, path: absolute };
  }
  const listed = remoteBranches(remote);
  if (!listed.ok) {
    return { ok: false, reason: `  ${listed.reason}` };
  }
  if (listed.names.length === 0) {
    return { ok: false, reason: `  ${remote} has no branches.` };
  }
  const suggested = remoteHead(remote);
  let branch = "";
  for (let tries = 0; tries < 3; tries += 1) {
    const options: { fallback?: string; required?: boolean; write?: (line: string) => void } = {
      required: true,
      write: input.write,
    };
    if (suggested !== undefined) {
      options.fallback = suggested;
    }
    branch = await askText(ask, "  Branch", options);
    if (listed.names.includes(branch)) {
      break;
    }
    input.write(`  ${remote} has no branch "${branch}". It has: ${listed.names.join(", ")}\n`);
  }
  return cloneChecked(input, remote, branch, absolute);
}

type InitFlags = {
  ok: true;
  manager: string;
  managerOptions: Record<string, unknown>;
  workLineStable: string | undefined;
  clone: string | undefined;
  branch: string | undefined;
  force: boolean;
};

function parseInitFlags(
  argv: string[],
  interactive: boolean,
): InitFlags | { ok: false; reason: string } {
  const flags: InitFlags = {
    ok: true,
    manager: "",
    managerOptions: {},
    workLineStable: undefined,
    clone: undefined,
    branch: undefined,
    force: false,
  };
  let i = 0;
  while (i < argv.length) {
    const token = argv[i];
    if (token === "--interactive") {
      i += 1;
      continue;
    }
    if (token === "--force" || token === "--yes") {
      flags.force = true;
      i += 1;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      return { ok: false, reason: `Missing value for ${token}.` };
    }
    switch (token) {
      case "--manager":
        flags.manager = value;
        break;
      case "--manager-option": {
        const added = addManagerOption(flags.managerOptions, value);
        if (!added.ok) {
          return added;
        }
        break;
      }
      case "--work-line-stable":
        flags.workLineStable = value;
        break;
      case "--clone":
        flags.clone = value;
        break;
      case "--branch":
        flags.branch = value;
        break;
      default:
        return { ok: false, reason: `Unknown argument "${token}".` };
    }
    i += 2;
  }
  if (!interactive && flags.manager.trim().length === 0) {
    return {
      ok: false,
      reason: "Missing --manager. Name a package that exports createManager.",
    };
  }
  return flags;
}

function addManagerOption(
  options: Record<string, unknown>,
  raw: string,
): { ok: true } | { ok: false; reason: string } {
  const separator = raw.indexOf("=");
  if (separator < 1) {
    return { ok: false, reason: "--manager-option must be key=value." };
  }
  const key = raw.slice(0, separator).trim();
  const value = raw.slice(separator + 1);
  if (key.length === 0) {
    return { ok: false, reason: "--manager-option must be key=value." };
  }
  const existing = options[key];
  if (existing === undefined) {
    options[key] = value;
  } else if (Array.isArray(existing)) {
    existing.push(value);
  } else {
    options[key] = [existing, value];
  }
  return { ok: true };
}

function hostNextSteps(): string[] {
  return [
    `${BUILDER_FILENAME} — your producer; or point builder.producer at @bluewombat/slots/builders/producer.mjs and builder.repair at builders/repair.mjs, with an agent after --`,
    `builder.producer.gates.gates in ${CONFIG_FILENAME} — start with workspace-changed (examples in @bluewombat/slots/gates/); builder.repair.gates is separate and runs ungated until you add one`,
    `authority.enabled in ${CONFIG_FILENAME} — true to offer the assembled feature outside, which then needs assembly.fix (assembly.validate is another way to send work back to it, local and optional)`,
  ];
}

/**
 * The bootstrap Planner from `@bluewombat/slots`.
 *
 * The Project's own copy answers first, named the way every example names it.
 * Resolving instead would follow a `npm link` symlink to its realpath and write
 * the path of some clone on this machine into a config meant to be committed.
 *
 * Only a Project without that copy falls through to resolution — the slots are
 * their own package, and where an installer put them is its business.
 */
function plannerPath(cwd: string): string {
  if (existsSync(resolve(cwd, PLANNER_IN_PROJECT))) {
    return PLANNER_IN_PROJECT;
  }
  const absolutePath = fileURLToPath(import.meta.resolve(BOOTSTRAP_PLANNER));
  const nearby = relative(cwd, absolutePath);
  return nearby.startsWith("..") || isAbsolute(nearby) ? absolutePath : `./${nearby}`;
}
