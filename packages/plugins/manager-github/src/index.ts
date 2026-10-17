import {
  booleanOption,
  type CreateManagerResult,
  EVENT_NAMES,
  type Finding,
  intOption,
  type ManagerContext,
  type ManagerQuestion,
  type ManagerScaffold,
  type ManagerSide,
  PRODUCT,
  rejectUnknownOptions,
  type SetupResult,
  stringOption,
} from "@bluewombat/manager-kit";
import { type LabelColors, resolveLabelColors } from "./label-colors.js";
import {
  createGithubManager,
  DEFAULT_API_BASE,
  DEFAULT_FEATURE_READY_LABEL,
  DEFAULT_MERGE_WHEN_READY_LABEL,
  DEFAULT_NO_TESTS_LABEL,
  DEFAULT_RESUME_LABEL,
  DEFAULT_TICKET_READY_LABEL,
  DEFAULT_TOKEN_ENV,
  type GithubManagerOptions,
} from "./manager.js";
import { parseRepo, type Repository } from "./repo.js";
import { runSetup } from "./setup.js";
import { resolveStateLabels, type StateLabels } from "./state-labels.js";

export { issueNumberFromExternalId, issueNumberFromPayload } from "./issue-number.js";
export { payloadHasLabel } from "./labels.js";
export type { GithubManagerOptions } from "./manager.js";
export {
  createGithubManager,
  DEFAULT_API_BASE,
  DEFAULT_FEATURE_READY_LABEL,
  DEFAULT_MERGE_WHEN_READY_LABEL,
  DEFAULT_PRIORITY,
  DEFAULT_RESUME_LABEL,
  DEFAULT_TICKET_READY_LABEL,
  DEFAULT_TOKEN_ENV,
} from "./manager.js";
export { parseRepo, type Repository } from "./repo.js";
export { type SetupSettings, wantedLabels } from "./setup.js";

/** What `mason init` asks when it runs at a terminal. */
export function questionsManager(): ManagerQuestion[] {
  return [
    {
      key: "repo",
      prompt: "GitHub repository (owner/name)",
      required: true,
      parse: (answer) =>
        parseRepo(answer) === null
          ? { ok: false, reason: `"${answer}" is not owner/name.` }
          : { ok: true, value: answer },
    },
    {
      key: "defaultProject",
      prompt: "Project name for issues with no project: label",
      fallback: "app",
    },
    {
      key: "tokenEnv",
      prompt: "Environment variable holding the token",
      fallback: DEFAULT_TOKEN_ENV,
    },
  ];
}

/**
 * `mason setup`. The only entry point of this package that writes to GitHub
 * before a run: it creates the labels the configuration names, once `apply` is
 * asked for.
 */
export async function setupManager(
  context: ManagerContext,
  input: { apply: boolean },
): Promise<SetupResult> {
  const read = readOptions(context);
  if (!read.ok) {
    return {
      ok: false,
      steps: [
        { id: "options", summary: "read managerOptions", state: "blocked", detail: read.reason },
      ],
    };
  }
  const settings = read.settings;
  const token = settings.token ?? context.env[settings.tokenEnv];
  if (token === undefined || token.trim().length === 0) {
    return {
      ok: false,
      steps: [
        {
          id: "token",
          summary: "a token to talk to GitHub",
          state: "blocked",
          detail: `${settings.tokenEnv} is not set.`,
        },
      ],
    };
  }
  return await runSetup(
    {
      repo: settings.repo,
      token,
      apiBase: settings.apiBase,
      resumeLabel: settings.resumeLabel,
      featureReadyLabel: settings.featureReadyLabel,
      ticketReadyLabel: settings.ticketReadyLabel,
      noTestsLabel: settings.noTestsLabel,
      mergeWhenReadyLabel: settings.mergeWhenReadyLabel,
      sides: settings.sides,
      defaultProject: settings.defaultProject,
      stateLabels: settings.stateLabels,
      labelColors: settings.labelColors,
      branch: settings.branch,
      branchConfigured: typeof context.options.branch === "string",
      durationMs: context.durationMs,
      interruptFlag: context.interruptFlag,
      githubFetch: settings.githubFetch,
    },
    input,
  );
}

const KNOWN_OPTIONS = [
  "repo",
  "token",
  "tokenEnv",
  "apiBase",
  "defaultProject",
  "resumeLabel",
  "featureReadyLabel",
  "ticketReadyLabel",
  "noTestsLabel",
  "mergeWhenReadyLabel",
  "defaultPriority",
  "stateLabels",
  "labelColors",
  "branch",
  "remote",
  "commitAuthor",
  "keepBranch",
  "fetch",
] as const;

/**
 * The label options that belong to one side. `featureReadyLabel` and
 * `mergeWhenReadyLabel` are read only for Features, `ticketReadyLabel` only for
 * Tickets, so each is written under the side it belongs to; the others
 * (`resumeLabel`, `stateLabels`, `defaultProject`, ...) serve both.
 */
const SIDE_OPTIONS: Record<ManagerSide, readonly string[]> = {
  featureTracker: ["featureReadyLabel", "mergeWhenReadyLabel"],
  ticketTracker: ["ticketReadyLabel", "noTestsLabel"],
};

const BOTH_SIDES: readonly ManagerSide[] = ["featureTracker", "ticketTracker"];

/** The first option written under a side that does not use it. */
function misplacedOption(
  options: Record<string, unknown>,
  sides: readonly ManagerSide[],
): { name: string; belongsTo: ManagerSide } | undefined {
  for (const side of BOTH_SIDES) {
    if (sides.includes(side)) {
      continue;
    }
    for (const name of SIDE_OPTIONS[side]) {
      if (options[name] !== undefined) {
        return { name, belongsTo: side };
      }
    }
  }
  return undefined;
}

export const DEFAULT_BRANCH = "main";
export const DEFAULT_GIT_HOST = "github.com";

type Settings = {
  repo: Repository;
  tokenEnv: string;
  token: string | undefined;
  apiBase: string;
  resumeLabel: string;
  featureReadyLabel: string;
  ticketReadyLabel: string;
  noTestsLabel: string;
  mergeWhenReadyLabel: string;
  /** The sides of the config this manager is built for. */
  sides: readonly ManagerSide[];
  defaultProject: string | undefined;
  defaultPriority: number | undefined;
  /** The label each Event lands as; absent: the Events leave no label. */
  stateLabels: StateLabels | undefined;
  labelColors: LabelColors | undefined;
  branch: string;
  remote: string;
  /** Who the system is on the commits it makes: `Name <email>`. */
  commitAuthor: { name: string; email: string } | undefined;
  /** Leave the ticket branch after a fold. Default: delete it. */
  keepBranch: boolean | undefined;
  githubFetch: typeof fetch | undefined;
};

type Read = { ok: true; settings: Settings } | { ok: false; reason: string };

/**
 * `manager: "@bluewombat/manager-github"` in the config resolves here. The token
 * is read from the environment by this package: Host never handles a secret.
 */
export function createManager(context: ManagerContext): CreateManagerResult {
  const read = readOptions(context);
  if (!read.ok) {
    return read;
  }
  const settings = read.settings;
  const token = settings.token ?? context.env[settings.tokenEnv];
  if (token === undefined || token.trim().length === 0) {
    return {
      ok: false,
      reason:
        `GitHub needs a token in ${settings.tokenEnv}. ` +
        'Set the variable, or name another one with managerOptions "tokenEnv".',
    };
  }
  const options: GithubManagerOptions = {
    repo: settings.repo,
    token,
    durationMs: context.durationMs,
    interruptFlag: context.interruptFlag,
    apiBase: settings.apiBase,
    resumeLabel: settings.resumeLabel,
    featureReadyLabel: settings.featureReadyLabel,
    ticketReadyLabel: settings.ticketReadyLabel,
    noTestsLabel: settings.noTestsLabel,
    mergeWhenReadyLabel: settings.mergeWhenReadyLabel,
  };
  if (settings.defaultProject !== undefined) {
    options.defaultProject = settings.defaultProject;
  }
  if (settings.defaultPriority !== undefined) {
    options.defaultPriority = settings.defaultPriority;
  }
  if (settings.stateLabels !== undefined) {
    options.stateLabels = settings.stateLabels;
  }
  if (settings.keepBranch !== undefined) {
    options.keepBranch = settings.keepBranch;
  }
  if (settings.githubFetch !== undefined) {
    options.githubFetch = settings.githubFetch;
  }
  return { ok: true, manager: createGithubManager(options) };
}

/**
 * What `mason init` writes. Labels are not created here: that would need the
 * network, and a missing label is a repository fact the operator still owns.
 */
export function scaffoldManager(context: ManagerContext): ManagerScaffold {
  const repo = typeof context.options.repo === "string" ? context.options.repo : "OWNER/REPO";
  // The variable the operator just named, not the default: `init` calls this
  // again with the answers in hand so its next steps do not demand something
  // else than what was typed.
  const tokenEnv =
    typeof context.options.tokenEnv === "string" && context.options.tokenEnv.length > 0
      ? context.options.tokenEnv
      : DEFAULT_TOKEN_ENV;
  // `mason setup` creates the labels, so nothing here asks for that by hand.
  const nextSteps = [`${tokenEnv} — a token with the repo scope, exported in this shell`];
  if (repo === "OWNER/REPO") {
    nextSteps.unshift(
      "managerOptions.repo — set it to owner/name (or pass --manager-option repo=owner/name)",
    );
  }
  return {
    options: {
      repo,
      tokenEnv,
      resumeLabel: DEFAULT_RESUME_LABEL,
      defaultProject: "app",
    },
    nextSteps,
  };
}

/** What `mason doctor` reports. Options and environment only, no network. */
export function checkManager(context: ManagerContext): Finding[] {
  const read = readOptions(context);
  if (!read.ok) {
    return [{ level: "fail", label: "manager options", detail: read.reason }];
  }
  const settings = read.settings;
  const token = settings.token ?? context.env[settings.tokenEnv];
  const findings: Finding[] = [
    {
      level: "ok",
      label: "repository",
      detail: `${settings.repo.owner}/${settings.repo.name}`,
    },
    token === undefined || token.trim().length === 0
      ? { level: "fail", label: "token", detail: `${settings.tokenEnv} is not set` }
      : { level: "ok", label: "token", detail: `${settings.tokenEnv} is set` },
  ];
  const served = [
    ...(settings.sides.includes("featureTracker")
      ? [`${settings.featureReadyLabel} (Feature)`, `${settings.mergeWhenReadyLabel} (Feature)`]
      : []),
    ...(settings.sides.includes("ticketTracker")
      ? [`${settings.ticketReadyLabel} (Ticket)`, `${settings.noTestsLabel} (no tests)`]
      : []),
    `${settings.resumeLabel} (resume)`,
  ];
  findings.push({ level: "ok", label: "labels", detail: served.join(", ") });
  findings.push(
    settings.stateLabels === undefined
      ? { level: "ok", label: "state labels", detail: "off: no stateLabels" }
      : {
          level: "ok",
          label: "state labels",
          detail: EVENT_NAMES.map((event) => settings.stateLabels?.[event]).join(", "),
        },
  );
  findings.push(
    settings.commitAuthor === undefined
      ? {
          level: "warn",
          label: "commit author",
          detail:
            "no \"commitAuthor\": commits will carry this machine's git identity, not the system's",
        }
      : {
          level: "ok",
          label: "commit author",
          detail: `${settings.commitAuthor.name} <${settings.commitAuthor.email}>`,
        },
  );
  findings.push(
    settings.remote.startsWith("https://")
      ? {
          level: "ok",
          label: "git remote",
          detail: `${settings.remote} — with ${settings.tokenEnv}`,
        }
      : {
          level: "warn",
          label: "git remote",
          detail: `${settings.remote} — not HTTPS, so git authenticates with this machine's keys, not the token`,
        },
  );
  // Whether the repository has the labels is `mason setup`'s question: doctor
  // stays offline and does not guess.
  return findings;
}

function readOptions(context: ManagerContext): Read {
  const known = rejectUnknownOptions(context.options, KNOWN_OPTIONS);
  if (!known.ok) {
    return known;
  }
  const sides = context.sides ?? BOTH_SIDES;
  const misplaced = misplacedOption(context.options, sides);
  if (misplaced !== undefined) {
    return {
      ok: false,
      reason: `"${misplaced.name}" belongs under ${misplaced.belongsTo}, not under ${sides.join(" and ")}.`,
    };
  }
  const repoRaw = stringOption(context.options, "repo");
  if (!repoRaw.ok) {
    return repoRaw;
  }
  if (repoRaw.value === undefined) {
    return { ok: false, reason: 'managerOptions "repo" is required (owner/name).' };
  }
  const repo = parseRepo(repoRaw.value);
  if (repo === null) {
    return { ok: false, reason: 'managerOptions "repo" must be owner/name.' };
  }
  const token = stringOption(context.options, "token");
  if (!token.ok) {
    return token;
  }
  const tokenEnv = stringOption(context.options, "tokenEnv");
  if (!tokenEnv.ok) {
    return tokenEnv;
  }
  const apiBase = stringOption(context.options, "apiBase");
  if (!apiBase.ok) {
    return apiBase;
  }
  const defaultProject = stringOption(context.options, "defaultProject");
  if (!defaultProject.ok) {
    return defaultProject;
  }
  const resumeLabel = stringOption(context.options, "resumeLabel");
  if (!resumeLabel.ok) {
    return resumeLabel;
  }
  const featureReadyLabel = stringOption(context.options, "featureReadyLabel");
  if (!featureReadyLabel.ok) {
    return featureReadyLabel;
  }
  const ticketReadyLabel = stringOption(context.options, "ticketReadyLabel");
  if (!ticketReadyLabel.ok) {
    return ticketReadyLabel;
  }
  const noTestsLabel = stringOption(context.options, "noTestsLabel");
  if (!noTestsLabel.ok) {
    return noTestsLabel;
  }
  const mergeWhenReadyLabel = stringOption(context.options, "mergeWhenReadyLabel");
  if (!mergeWhenReadyLabel.ok) {
    return mergeWhenReadyLabel;
  }
  const defaultPriority = intOption(context.options, "defaultPriority", 0, 100);
  if (!defaultPriority.ok) {
    return defaultPriority;
  }
  const named = namesOption(context.options, "stateLabels");
  if (!named.ok) {
    return named;
  }
  const stateLabels = resolveStateLabels(named.value);
  if (!stateLabels.ok) {
    return stateLabels;
  }
  const namedColours = namesOption(context.options, "labelColors");
  if (!namedColours.ok) {
    return namedColours;
  }
  const labelColors = resolveLabelColors(namedColours.value);
  if (!labelColors.ok) {
    return labelColors;
  }
  const branch = stringOption(context.options, "branch");
  if (!branch.ok) {
    return branch;
  }
  const remote = stringOption(context.options, "remote");
  if (!remote.ok) {
    return remote;
  }
  const commitAuthor = stringOption(context.options, "commitAuthor");
  if (!commitAuthor.ok) {
    return commitAuthor;
  }
  const author = commitAuthor.value === undefined ? undefined : parseAuthor(commitAuthor.value);
  if (author !== undefined && !author.ok) {
    return author;
  }
  const keepBranch = booleanOption(context.options, "keepBranch");
  if (!keepBranch.ok) {
    return keepBranch;
  }
  const candidateFetch = context.options.fetch;
  if (candidateFetch !== undefined && typeof candidateFetch !== "function") {
    return { ok: false, reason: 'managerOptions "fetch" must be a function (tests only).' };
  }
  return {
    ok: true,
    settings: {
      repo,
      token: token.value,
      tokenEnv: tokenEnv.value ?? DEFAULT_TOKEN_ENV,
      apiBase: apiBase.value ?? DEFAULT_API_BASE,
      resumeLabel: resumeLabel.value ?? DEFAULT_RESUME_LABEL,
      featureReadyLabel: featureReadyLabel.value ?? DEFAULT_FEATURE_READY_LABEL,
      ticketReadyLabel: ticketReadyLabel.value ?? DEFAULT_TICKET_READY_LABEL,
      noTestsLabel: noTestsLabel.value ?? DEFAULT_NO_TESTS_LABEL,
      mergeWhenReadyLabel: mergeWhenReadyLabel.value ?? DEFAULT_MERGE_WHEN_READY_LABEL,
      sides,
      defaultProject: defaultProject.value,
      defaultPriority: defaultPriority.value,
      stateLabels: stateLabels.labels,
      labelColors: labelColors.colors,
      branch: branch.value ?? DEFAULT_BRANCH,
      remote: remote.value ?? `https://${DEFAULT_GIT_HOST}/${repo.owner}/${repo.name}.git`,
      commitAuthor: author?.value,
      keepBranch: keepBranch.value,
      githubFetch: candidateFetch as typeof fetch | undefined,
    },
  };
}

/** An option that is a mapping of names to non-empty strings: `{ done: "mason:done" }`. */
function namesOption(
  options: Record<string, unknown>,
  name: string,
): { ok: true; value: Record<string, string> | undefined } | { ok: false; reason: string } {
  const raw = options[name];
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: `managerOptions "${name}" must be a mapping of names to labels.` };
  }
  const value: Record<string, string> = {};
  for (const [key, label] of Object.entries(raw)) {
    if (typeof label !== "string" || label.trim().length === 0) {
      return {
        ok: false,
        reason: `managerOptions "${name}.${key}" must be a non-empty string.`,
      };
    }
    value[key] = label;
  }
  return { ok: true, value };
}

/** `Name <email>`, the form `git log` prints. */
export function parseAuthor(
  text: string,
): { ok: true; value: { name: string; email: string } } | { ok: false; reason: string } {
  const match = /^\s*(.+?)\s*<([^<>\s]+@[^<>\s]+)>\s*$/.exec(text);
  if (match?.[1] === undefined || match[2] === undefined) {
    return {
      ok: false,
      reason: `managerOptions "commitAuthor" must read "Name <email>", e.g. "${PRODUCT} <${PRODUCT}@example.com>".`,
    };
  }
  return { ok: true, value: { name: match[1], email: match[2] } };
}

/**
 * Where the reference work line is: the repository's own git remote, and the
 * branch pull requests are opened onto. Host keeps a copy of it; these are the
 * words `@bluewombat/isolation-git` reads.
 *
 * Over HTTPS by default, authenticated with the same token as the API —
 * `credentialEnv` names the variable, and the strategy reads it when git asks,
 * so nothing lands in a `.git/config` on disk and the pushes are the token's
 * account, not the machine's SSH key. `remote` overrides the URL (SSH, a
 * mirror, GitHub Enterprise). `author` is who the system is on its commits.
 */
export function referenceManager(context: ManagerContext): Record<string, unknown> | undefined {
  const read = readOptions(context);
  if (!read.ok) {
    return undefined;
  }
  const { remote, branch, tokenEnv, commitAuthor } = read.settings;
  return {
    remote,
    branch,
    ...(remote.startsWith("https://") ? { credentialEnv: tokenEnv } : {}),
    ...(commitAuthor === undefined ? {} : { author: commitAuthor }),
  };
}
