# Manager: GitHub Issues

The FeatureManager triplet for GitHub Issues: issues in, issue comments (and
optional state labels) out, over the REST API with a token.
Contract: [SPECS.md](./SPECS.md).

```bash
npm install @bluewombat/runtime @bluewombat/manager-github
npx mason init --manager @bluewombat/manager-github --manager-option repo=owner/name
export GITHUB_TOKEN=…
```

```json
{
  "manager": "@bluewombat/manager-github",
  "managerOptions": {
    "repo": "owner/name",
    "labels": ["mason"],
    "readyLabel": "ready",
    "defaultProject": "app",
    "stateLabelPrefix": "mason:"
  }
}
```

The token is read by this package from the environment; it never appears in the
config file and Host never sees it.

## What an issue says

The body is the intention, word for word, less what GitHub itself put there:
the comments an issue template leaves behind, and the boxes of a task list —
`- [ ] a CSV downloads` reaches the Planner as `- a CSV downloads`. Nothing is
read out of it: no checklist is required, no criteria are extracted (what
"done" means is the layer above mason's, not mason's). A body that was only a
template's comments falls back to the title.

That text, with the title, the project and the priority, is the issue's
fingerprint — what tells an **edit** from an **echo**. Comments, state labels
and a ticked box all move `updated_at` and deliver the issue again; none of
them changes the fingerprint. Rewording the body does, and on a Feature in
flight that is recorded and freezes it once the current unit lands, for a
human to decide. So: tick the boxes as you please; rewrite the words only when
you mean it.

## Options

| Option             | Required | Default                         | Meaning                                                                                                                                                                                                                                                                                                           |
| ------------------ | -------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repo`             | yes      | —                               | `owner/name` to poll                                                                                                                                                                                                                                                                                              |
| `tokenEnv`         | no       | `GITHUB_TOKEN`                  | Environment variable holding the token                                                                                                                                                                                                                                                                            |
| `token`            | no       | —                               | The token itself. For embedding and tests; prefer `tokenEnv`                                                                                                                                                                                                                                                      |
| `apiBase`          | no       | `https://api.github.com`        | REST base, for GitHub Enterprise                                                                                                                                                                                                                                                                                  |
| `labels`           | no       | none                            | Every listed label must be on the issue for it to be admitted                                                                                                                                                                                                                                                     |
| `readyLabel`       | no       | `ready`                         | On an escalated Feature, this label means resume                                                                                                                                                                                                                                                                  |
| `defaultProject`   | no       | `unknown`                       | Project when no `project:` label says otherwise                                                                                                                                                                                                                                                                   |
| `defaultPriority`  | no       | `50`                            | Priority when no `priority:` label says otherwise (0…100)                                                                                                                                                                                                                                                         |
| `stateLabelPrefix` | no       | none                            | When set, state labels (`mason:done`, …) are moved too                                                                                                                                                                                                                                                            |
| `branch`           | no       | `main`                          | The work line pull requests are opened onto. `mason setup` checks it exists and names the repository's default branch when it does not                                                                                                                                                                            |
| `remote`           | no       | `https://github.com/<repo>.git` | Git URL of the repository, for Host's copy of the work line. Over HTTPS, git authenticates with the token in `tokenEnv` — read when git asks, never written to disk — so pushes are the token's account. Set it for GitHub Enterprise, a mirror, or SSH (then this machine's keys are used, and `doctor` says so) |
| `keepBranch`       | no       | `false`                         | Leave the feature branch on the remote after the fold. By default it is deleted once the squash is on the work line                                                                                                                                                                                               |
| `commitAuthor`     | no       | none                            | `Name <email>`: who the system is on the commits it makes. Without it, commits carry this machine's git identity, and `doctor` warns. Use the token's account (its noreply address works) so GitHub credits the system, not a person                                                                              |

## Submissions

This manager is an Authority: it offers an assembled feature to the repository
as a pull request, and takes an accepted one in.

| Method    | On GitHub                                                                                                                                                                                                    |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `submit`  | Opens a pull request from the published branch onto `workLine.branch`. An open one on the same branch is reused, never duplicated                                                                            |
| `verdict` | Reads the checks on the pull request's head commit                                                                                                                                                           |
| `fold`    | Squash-merges it: the commit's title is the pull request's; its body is what the Project's Describer said (carried on the pull request), else `Closes #N` alone. Then deletes the branch unless `keepBranch` |

The pull request is titled after the issue (trailing full stop dropped, `(#N)`
appended) and its body is the issue's intention, the Plan's steps, and
`Closes #N` — so GitHub closes the issue when the pull request is merged.
Nothing in it is generated.

`verdict` counts the grace for a commit with no check from the **commit**, not
from the pull request: one that was sent back and published again is old while
its commit is seconds old, and reading "no check yet" as "no checks exist" folds
it unjudged.

`clearReady` takes the `readyLabel` off an issue once a resume has been acted
on, so an escalation freezes instead of resuming on every pass.

`probe` asks whether an issue Host already holds is still there. A poll cannot
see a deletion: the issue is simply missing from every later page. Open is
present; closed or 404 is gone (Host treats that as abandon). Any other error
is unavailable, so a missed read does not cancel work.

`referenceManager` names where the reference work line is — `remote` and
`branch` — and who the system is there — `credentialEnv` (the token variable,
for an HTTPS remote) and `author` (from `commitAuthor`) — in the words
`@bluewombat/isolation-git` reads. With it, Host keeps its own copy at
`<home>/work-line` (`.mason` by default) and `workLine.stable` need not be set.

One rule about identity: the only thing done in a person's name is the issue
they wrote. Comments, labels, pull requests and merges are the token's
account; commits are `commitAuthor`; pushes and fetches use the token. A copy
made before `remote` changed (SSH to HTTPS, say) no longer matches: delete it
and the next run clones again.

## Prepare the repository

`mason setup` reads the config and says what the repository still needs;
`--apply` creates it. It is idempotent, so it is safe to re-run after changing
`labels` or turning `stateLabelPrefix` on.

```bash
mason setup --apply
```

| Checked                     | How                                                                                                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The repository is reachable | `GET /repos/{owner}/{repo}` — a 404 means "not found, or this token cannot see it"                                                                                                         |
| Issues are enabled          | `has_issues` on that same response                                                                                                                                                         |
| The token can write         | `permissions.push` on that same response, rather than guessing at scopes                                                                                                                   |
| The branch exists           | `GET /repos/{owner}/{repo}/branches/{branch}` for `branch` (default `main`); when it is missing and the config named none, the step says the repository's default branch and what to write |
| Labels                      | `labels`, `readyLabel`, `project:<defaultProject>`, and one per Event when `stateLabelPrefix` is set                                                                                       |

Creating a label is the only write; nothing existing is renamed, recoloured, or
deleted.

## Stack

Repository stack — TypeScript, Node 24.20, Biome, `node:test`. See [docs/DEVELOPMENT.md](../../../docs/DEVELOPMENT.md).

## Setup

From the repository root:

```bash
nvm use
npm install
```

## Commands

| Task      | Command          |
| --------- | ---------------- |
| Lint      | `npm run lint`   |
| Format    | `npm run format` |
| Typecheck | `npm run tsc`    |
| Test      | `npm test`       |
| Build     | `npm run build`  |

## Layout

```
SPECS.md          the contract
README.md         how to build and configure it
src/
  index.ts        createManager, checkManager, scaffoldManager — the plugin face
  manager.ts      the ManagerPort (listen / adapt / report / probe live in listener/, adapter/, emitter/, probe/)
  github/         Octokit channel shared by listen, adapt, report, and probe
  probe/          whether a minted key's issue is still on the tracker
  repo.ts         owner/name
  issue-number.ts the issue a key or a payload points at
  labels.ts       whether a payload carries a label
```
