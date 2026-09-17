import {
  booleanOption,
  type CreateManagerResult,
  type Finding,
  intOption,
  type ManagerContext,
  type ManagerQuestion,
  type ManagerScaffold,
  PRODUCT,
  rejectUnknownOptions,
  type SetupResult,
  stringArrayOption,
  stringOption,
} from "@bluewombat/manager-kit";
import {
  createGithubManager,
  DEFAULT_API_BASE,
  DEFAULT_READY_LABEL,
  DEFAULT_TOKEN_ENV,
  type GithubManagerOptions,
} from "./manager.js";
import { parseRepo, type Repository } from "./repo.js";
import { runSetup } from "./setup.js";

export { issueNumberFromExternalId, issueNumberFromPayload } from "./issue-number.js";
export { payloadHasLabel } from "./labels.js";
export type { GithubManagerOptions } from "./manager.js";
export {
  createGithubManager,
  DEFAULT_API_BASE,
  DEFAULT_PRIORITY,
  DEFAULT_READY_LABEL,
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
      key: "labels",
      prompt: "Label an issue must carry to be picked up",
      fallback: PRODUCT,
      parse: (answer) => ({ ok: true, value: [answer] }),
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
      readyLabel: settings.readyLabel,
      labels: settings.labels,
      defaultProject: settings.defaultProject,
      stateLabelPrefix: settings.stateLabelPrefix,
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
  "labels",
  "defaultProject",
  "readyLabel",
  "defaultPriority",
  "stateLabelPrefix",
  "branch",
  "remote",
  "commitAuthor",
  "keepBranch",
  "fetch",
] as const;

export const DEFAULT_BRANCH = "main";
export const DEFAULT_GIT_HOST = "github.com";

type Settings = {
  repo: Repository;
  tokenEnv: string;
  token: string | undefined;
  apiBase: string;
  readyLabel: string;
  labels: string[] | undefined;
  defaultProject: string | undefined;
  defaultPriority: number | undefined;
  stateLabelPrefix: string | undefined;
  branch: string;
  remote: string;
  /** Who the system is on the commits it makes: `Name <email>`. */
  commitAuthor: { name: string; email: string } | undefined;
  /** Leave the feature branch after a fold. Default: delete it. */
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
    readyLabel: settings.readyLabel,
  };
  if (settings.labels !== undefined) {
    options.labels = settings.labels;
  }
  if (settings.defaultProject !== undefined) {
    options.defaultProject = settings.defaultProject;
  }
  if (settings.defaultPriority !== undefined) {
    options.defaultPriority = settings.defaultPriority;
  }
  if (settings.stateLabelPrefix !== undefined) {
    options.stateLabelPrefix = settings.stateLabelPrefix;
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
      labels: [PRODUCT],
      readyLabel: "ready",
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
  if (settings.labels === undefined || settings.labels.length === 0) {
    findings.push({
      level: "warn",
      label: "labels",
      detail: "every open issue is admitted; set labels to narrow the Source",
    });
  } else {
    findings.push({ level: "ok", label: "labels", detail: settings.labels.join(", ") });
  }
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
  const labels = stringArrayOption(context.options, "labels");
  if (!labels.ok) {
    return labels;
  }
  const defaultProject = stringOption(context.options, "defaultProject");
  if (!defaultProject.ok) {
    return defaultProject;
  }
  const readyLabel = stringOption(context.options, "readyLabel");
  if (!readyLabel.ok) {
    return readyLabel;
  }
  const defaultPriority = intOption(context.options, "defaultPriority", 0, 100);
  if (!defaultPriority.ok) {
    return defaultPriority;
  }
  const stateLabelPrefix = stringOption(context.options, "stateLabelPrefix");
  if (!stateLabelPrefix.ok) {
    return stateLabelPrefix;
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
      readyLabel: readyLabel.value ?? DEFAULT_READY_LABEL,
      labels: labels.value,
      defaultProject: defaultProject.value,
      defaultPriority: defaultPriority.value,
      stateLabelPrefix: stateLabelPrefix.value,
      branch: branch.value ?? DEFAULT_BRANCH,
      remote: remote.value ?? `https://${DEFAULT_GIT_HOST}/${repo.owner}/${repo.name}.git`,
      commitAuthor: author?.value,
      keepBranch: keepBranch.value,
      githubFetch: candidateFetch as typeof fetch | undefined,
    },
  };
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
