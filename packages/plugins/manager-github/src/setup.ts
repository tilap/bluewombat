import { EVENT_NAMES, PRODUCT, type SetupResult, type SetupStep } from "@bluewombat/manager-kit";
import { callSignal, createClient, type GithubClient, readFailure } from "./github/client.js";
import type { Repository } from "./repo.js";

const PER_PAGE = 100;

/** Colours are only there so a human can tell the families apart at a glance. */
const READY_COLOUR = "0e8a16";
const ADMISSION_COLOUR = "1d76db";
const STATE_COLOUR = "5319e7";
const PROJECT_COLOUR = "c5def5";

export type SetupSettings = {
  repo: Repository;
  token: string;
  apiBase: string;
  readyLabel: string;
  labels: string[] | undefined;
  defaultProject: string | undefined;
  stateLabelPrefix: string | undefined;
  /** The branch pull requests are opened onto, and whether the config named it. */
  branch: string;
  branchConfigured: boolean;
  durationMs: number;
  interruptFlag: { interrupted: boolean };
  githubFetch: typeof fetch | undefined;
};

type WantedLabel = { name: string; colour: string; description: string };

/**
 * Bring one repository to the shape a run expects: reachable, issues on, a
 * token that can write, and every label the config names.
 *
 * Idempotent by construction — it asks what is there before it creates
 * anything, and creating a label that already exists is never attempted.
 */
export async function runSetup(
  settings: SetupSettings,
  input: { apply: boolean },
): Promise<SetupResult> {
  const now = (): number => Date.now();
  const deadlineMs = now() + settings.durationMs;
  const shouldInterrupt = (): boolean => settings.interruptFlag.interrupted;
  const github = createClient({
    token: settings.token,
    apiBase: settings.apiBase,
    requestRetries: settings.githubFetch === undefined ? 2 : 0,
    deadlineMs,
    now,
    shouldInterrupt,
    throttle: settings.githubFetch === undefined,
    ...(settings.githubFetch !== undefined ? { fetch: settings.githubFetch } : {}),
  });
  const context = { deadlineMs, now, shouldInterrupt };
  const steps: SetupStep[] = [];

  const repository = await readRepository(github, settings.repo, settings, context);
  if (repository.ok === false) {
    steps.push(repository.step);
    return { ok: false, steps };
  }
  steps.push(...repository.steps);
  if (repository.steps.some((step) => step.state === "blocked")) {
    return { ok: false, steps };
  }

  const present = await readLabels(github, settings.repo, context);
  if (present.ok === false) {
    steps.push(present.step);
    return { ok: false, steps };
  }

  const known = new Set(present.names.map((name) => name.toLowerCase()));
  for (const wanted of wantedLabels(settings)) {
    if (known.has(wanted.name.toLowerCase())) {
      steps.push({
        id: `label:${wanted.name}`,
        summary: `label ${wanted.name}`,
        state: "satisfied",
        detail: "already on the repository",
      });
      continue;
    }
    if (!input.apply) {
      steps.push({
        id: `label:${wanted.name}`,
        summary: `create label ${wanted.name}`,
        state: "missing",
        detail: wanted.description,
      });
      continue;
    }
    steps.push(await createLabel(github, settings.repo, wanted, context));
  }

  return { ok: steps.every((step) => step.state !== "blocked"), steps };
}

/** Every label this configuration will look for or write, and why it exists. */
export function wantedLabels(settings: {
  readyLabel: string;
  labels: string[] | undefined;
  defaultProject: string | undefined;
  stateLabelPrefix: string | undefined;
}): WantedLabel[] {
  const wanted: WantedLabel[] = [];
  for (const name of settings.labels ?? []) {
    wanted.push({
      name,
      colour: ADMISSION_COLOUR,
      description: `${PRODUCT} admits an issue only when it carries this label`,
    });
  }
  wanted.push({
    name: settings.readyLabel,
    colour: READY_COLOUR,
    description: `on an escalated feature, ${PRODUCT} resumes it`,
  });
  if (settings.defaultProject !== undefined) {
    wanted.push({
      name: `project:${settings.defaultProject}`,
      colour: PROJECT_COLOUR,
      description: `routes the issue to this ${PRODUCT} Project`,
    });
  }
  if (settings.stateLabelPrefix !== undefined) {
    for (const event of EVENT_NAMES) {
      wanted.push({
        name: `${settings.stateLabelPrefix}${event}`,
        colour: STATE_COLOUR,
        description: `${PRODUCT} state: ${event}`,
      });
    }
  }
  // A repeated name would try to create the same label twice.
  const seen = new Set<string>();
  return wanted.filter((label) => {
    const key = label.name.toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

type CallContext = { deadlineMs: number; now: () => number; shouldInterrupt: () => boolean };

async function readRepository(
  github: GithubClient,
  repo: Repository,
  settings: Pick<SetupSettings, "branch" | "branchConfigured">,
  context: CallContext,
): Promise<{ ok: true; steps: SetupStep[] } | { ok: false; step: SetupStep }> {
  const slug = `${repo.owner}/${repo.name}`;
  const call = callSignal(context.deadlineMs, context.now, context.shouldInterrupt);
  try {
    const response = await github.request("GET /repos/{owner}/{repo}", {
      owner: repo.owner,
      repo: repo.name,
      request: { signal: call.signal },
    });
    const data = response.data;
    const steps: SetupStep[] = [
      { id: "repository", summary: `repository ${slug}`, state: "satisfied" },
    ];
    steps.push(
      data.has_issues === true
        ? { id: "issues", summary: "issues are enabled", state: "satisfied" }
        : {
            id: "issues",
            summary: "issues are enabled",
            state: "blocked",
            detail: `Issues are turned off on ${slug}; ${PRODUCT} has no Source without them.`,
          },
    );
    // The authenticated repository response carries what this token may do,
    // which beats guessing at scope names.
    const push = data.permissions?.push;
    steps.push(
      push === true || push === undefined
        ? {
            id: "write-access",
            summary: "the token can write",
            state: "satisfied",
            ...(push === undefined ? { detail: "not reported by the API; assuming it can" } : {}),
          }
        : {
            id: "write-access",
            summary: "the token can write",
            state: "blocked",
            detail: `The token can read ${slug} but not write to it; comments and labels would fail.`,
          },
    );
    steps.push(
      await readBranch(
        github,
        repo,
        settings,
        {
          defaultBranch: typeof data.default_branch === "string" ? data.default_branch : undefined,
        },
        context,
      ),
    );
    return { ok: true, steps };
  } catch (error) {
    const failure = readFailure(error);
    return {
      ok: false,
      step: {
        id: "repository",
        summary: `repository ${slug}`,
        state: "blocked",
        detail:
          failure.status === 404
            ? `Not found, or this token cannot see it: ${slug}`
            : failure.detail,
      },
    };
  } finally {
    call.release();
  }
}

/**
 * The branch pull requests are opened onto has to exist. When the config did
 * not name one, `main` is a guess, and a repository on another default branch
 * would otherwise fail at the first run, one step later than here.
 */
async function readBranch(
  github: GithubClient,
  repo: Repository,
  settings: Pick<SetupSettings, "branch" | "branchConfigured">,
  repository: { defaultBranch: string | undefined },
  context: CallContext,
): Promise<SetupStep> {
  const slug = `${repo.owner}/${repo.name}`;
  const { branch, branchConfigured } = settings;
  const summary = `branch ${branch}`;
  const call = callSignal(context.deadlineMs, context.now, context.shouldInterrupt);
  try {
    await github.request("GET /repos/{owner}/{repo}/branches/{branch}", {
      owner: repo.owner,
      repo: repo.name,
      branch,
      request: { signal: call.signal },
    });
  } catch (error) {
    const failure = readFailure(error);
    if (failure.status !== 404) {
      return { id: "branch", summary, state: "blocked", detail: failure.detail };
    }
    const hint =
      repository.defaultBranch === undefined || repository.defaultBranch === branch
        ? ""
        : ` Its default branch is "${repository.defaultBranch}": set managerOptions.branch to it, or to the branch pull requests should target.`;
    return {
      id: "branch",
      summary,
      state: "blocked",
      detail: branchConfigured
        ? `No branch "${branch}" on ${slug} (managerOptions.branch).${hint}`
        : `No branch "${branch}" on ${slug}, and managerOptions.branch does not say.${hint}`,
    };
  } finally {
    call.release();
  }
  const detail =
    repository.defaultBranch === undefined || repository.defaultBranch === branch
      ? "the repository's default branch"
      : `not the default branch (${repository.defaultBranch}); pull requests are opened onto it`;
  return { id: "branch", summary, state: "satisfied", detail };
}

async function readLabels(
  github: GithubClient,
  repo: Repository,
  context: CallContext,
): Promise<{ ok: true; names: string[] } | { ok: false; step: SetupStep }> {
  const names: string[] = [];
  let page = 1;
  for (;;) {
    const call = callSignal(context.deadlineMs, context.now, context.shouldInterrupt);
    try {
      const response = await github.request("GET /repos/{owner}/{repo}/labels", {
        owner: repo.owner,
        repo: repo.name,
        per_page: PER_PAGE,
        page,
        request: { signal: call.signal },
      });
      for (const label of response.data) {
        names.push(label.name);
      }
      if (response.data.length < PER_PAGE) {
        return { ok: true, names };
      }
      page += 1;
    } catch (error) {
      return {
        ok: false,
        step: {
          id: "labels",
          summary: "read the repository labels",
          state: "blocked",
          detail: readFailure(error).detail,
        },
      };
    } finally {
      call.release();
    }
  }
}

async function createLabel(
  github: GithubClient,
  repo: Repository,
  wanted: WantedLabel,
  context: CallContext,
): Promise<SetupStep> {
  const call = callSignal(context.deadlineMs, context.now, context.shouldInterrupt);
  try {
    await github.request("POST /repos/{owner}/{repo}/labels", {
      owner: repo.owner,
      repo: repo.name,
      name: wanted.name,
      color: wanted.colour,
      description: wanted.description,
      request: { signal: call.signal },
    });
    return {
      id: `label:${wanted.name}`,
      summary: `create label ${wanted.name}`,
      state: "applied",
    };
  } catch (error) {
    return {
      id: `label:${wanted.name}`,
      summary: `create label ${wanted.name}`,
      state: "blocked",
      detail: readFailure(error).detail,
    };
  } finally {
    call.release();
  }
}
