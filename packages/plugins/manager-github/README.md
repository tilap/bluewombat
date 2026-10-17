# Manager: GitHub Issues

The FeatureTracker and TicketTracker for GitHub Issues: a Feature is an issue
carrying `feature-ready`, its Tickets are its sub-issues carrying `task-ready`;
comments (and optional state labels) go out, over the REST API with a token.
The same repository is the Authority: it cuts the lines and holds the pull
requests.
Contract: [SPECS.md](./SPECS.md).

```bash
npm install @bluewombat/runtime @bluewombat/manager-github
npx mason init --manager @bluewombat/manager-github --manager-option repo=owner/name
export GITHUB_TOKEN=…
```

```yaml
featureTracker:
  package: "@bluewombat/manager-github"
  options:
    repo: owner/name
    featureReadyLabel: feature-ready
    mergeWhenReadyLabel: merge-when-ready
    resumeLabel: to-resume
    defaultProject: app
    stateLabels: &stateLabels
      invalid: "mason:invalid"
      accepted: "mason:accepted"
      progress: "mason:progress"
      escalated: "mason:escalated"
      escalation_reminder: "mason:escalation_reminder"
      resumed: "mason:resumed"
      submitted: "mason:submitted"
      done: "mason:done"
      cancelled: "mason:cancelled"
      reject_late: "mason:reject_late"
ticketTracker:
  package: "@bluewombat/manager-github"
  options:
    repo: owner/name
    ticketReadyLabel: task-ready
    resumeLabel: to-resume
    defaultProject: app
    stateLabels: *stateLabels
```

Each label option is written under the side that uses it:
`featureReadyLabel` and `mergeWhenReadyLabel` under `featureTracker`,
`ticketReadyLabel` under `ticketTracker`. The package is told which side it
serves, so `mason setup` creates only that side's labels and `mason doctor`
names only those; an option under the wrong side is refused by name. The
options both sides read (`repo`, `tokenEnv`, `resumeLabel`, `defaultProject`,
`stateLabels`, …) are written under both.

A config that gives both sides the same options (a YAML anchor, say) builds one
manager serving both: every option is then accepted, and the label options may
share one name.

The same package answers both sides here; a Feature tracker of another tool
takes the first block alone (Features), and this package the second (Tickets,
lines).

The token is read by this package from the environment; it never appears in the
config file and Host never sees it.

## Features and Tickets

| On GitHub                                     | Means                                                                                                            |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| A top-level issue with `feature-ready`          | A Feature: its content is final, its Tickets may be written. Only these are listed. A sub-issue is never a Feature |
| Its sub-issues                                | Its Tickets, in the order GitHub gives them                                                                      |
| `task-ready` on a sub-issue                    | The Ticket's specification is final. A Feature starts only when every one of its Tickets carries it             |
| "Blocked by" (issue dependencies)             | On a Feature: the Features that must be done first. On a Ticket: the Tickets that must be done first            |
| `merge-when-ready` on a Feature               | Its line may be folded without a human. Without it, a human merges the pull request and the system waits         |
| `to-resume` on an escalated Feature or Ticket | Resume                                                                                                           |
| `priority:<n>`, `project:<name>` labels       | On a Feature and on a Ticket                                                                          |

The Feature and Ticket labels may share one name (`featureReadyLabel` and
`ticketReadyLabel` both `ready-for-agent`): a sub-issue is a Ticket whatever it
carries, and `mason setup` creates the label once.

## What an issue says

The body is the intention, word for word, less what GitHub itself put there:
the comments an issue template leaves behind, and the boxes of a task list —
`- [ ] a CSV downloads` reaches the Builder as `- a CSV downloads`. Nothing is
read out of it: no checklist is required, no criteria are extracted (what
"done" means is the layer above mason's, not mason's). A body that was only a
template's comments falls back to the title.

That text, with the title, the project and the priority, is the issue's
fingerprint — what tells an **edit** from an **echo**. Comments, state labels
and a ticked box all move `updated_at` and deliver the issue again; none of
them changes the fingerprint. Rewording the body does, and on a Ticket in
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
| `featureReadyLabel` (featureTracker) | no       | `feature-ready`                   | The label that makes an issue a Feature the system may take                                                                                                                                                                                                                                                       |
| `ticketReadyLabel` (ticketTracker) | no       | `task-ready`                     | The label a sub-issue carries once its specification is final                                                                                                                                                                                                                                                     |
| `mergeWhenReadyLabel` (featureTracker) | no    | `merge-when-ready`              | On a Feature: its line is folded without a human                                                                                                                                                                                                                                                                  |
| `resumeLabel`       | no       | `to-resume`                         | On an escalated Feature or Ticket, this label means resume; the escalation comment names it                                                                                                                                                                                                                                 |
| `defaultProject`   | no       | none                            | The Project of a Feature that has no `project:` label. Without it, such a Feature is refused as invalid (`missing-project`). `mason setup` creates the label `project:<defaultProject>` |
| `defaultPriority`  | no       | `50`                            | Priority when no `priority:` label says otherwise (0…100)                                                                                                                                                                                                                                                         |
| `stateLabels`      | no       | none                            | A mapping that names, for every Event, the label it lands as (see State labels). Absent: the Events leave no label |
| `labelColors`      | no       | none                            | A colour for each kind of label the setup creates, by what it is for, not by its name (see Label colours) |
| `branch`           | no       | `main`                          | The work line pull requests are opened onto. `mason setup` checks it exists and names the repository's default branch when it does not                                                                                                                                                                            |
| `remote`           | no       | `https://github.com/<repo>.git` | Git URL of the repository, for Host's copy of the work line. Over HTTPS, git authenticates with the token in `tokenEnv` — read when git asks, never written to disk — so pushes are the token's account. Set it for GitHub Enterprise, a mirror, or SSH (then this machine's keys are used, and `doctor` says so) |
| `keepBranch`       | no       | `false`                         | Leave the ticket branch on the remote after the fold. By default it is deleted once the squash is on the work line                                                                                                                                                                                               |
| `commitAuthor`     | no       | none                            | `Name <email>`: who the system is on the commits it makes. Without it, commits carry this machine's git identity, and `doctor` warns. Use the token's account (its noreply address works) so GitHub credits the system, not a person                                                                              |

## Submissions

This manager is an Authority: it cuts the line of a Feature, offers an
assembled Ticket (or a Feature's line) to the repository as a pull request, and
takes an accepted one in.

| Method    | On GitHub                                                                                                                                                                                                    |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `openLine`| Creates `feature/<n>` from `branch` (`git/refs`). A line that exists is a success                                                                                                                            |
| `dropLine`| Deletes a line nobody will fold                                                                                                                                                                              |
| `submit`  | Opens a pull request from the published branch onto the line it is offered to (a Feature's line, or `branch`). An open one on the same branch is reused, never duplicated                                   |
| `settled` | Whether the pull request is still open, was merged (by anyone), or was closed unmerged. A human's merge is read here                                                                                         |
| `behind`  | Whether the line holds commits the pull request does not (`compare` of the line's tip against the pull request's head, `behind_by`). Asked right before a `fold`. A failed read is `unavailable`, never `current` |
| `fold`    | Squash-merges it: the commit's title is the pull request's; its body is what the Project's Describer said (carried on the pull request), else `Closes #N` alone. Then deletes the branch unless `keepBranch` |

The pull request is titled after the issue (trailing full stop dropped, `(#N)`
appended) and its body is the issue's intention and
`Closes #N` — so GitHub closes the issue when the pull request is merged. GitHub honours `Closes` only for a merge into the default branch, so a Ticket folded into a Feature's line stays open until a reservation says otherwise (`docs/RESERVATIONS.md`).
Nothing in it is generated.

`verdict` counts the grace for a commit with no check from the **commit**, not
from the pull request: one that was sent back and published again is old while
its commit is seconds old, and reading "no check yet" as "no checks exist" folds
it unjudged.

`clearResume` takes the `resumeLabel` off an issue once a resume has been acted
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

## Talking to GitHub

Every call goes through `src/github/client.ts`: `@octokit/core` with its retry
and throttling plugins, under the invocation's own duration. Each attempt also
has a clock of its own, 30 seconds (`REQUEST_TIMEOUT_MS`): a connection that
goes silent fails as a transport error and is tried again, rather than holding
the call — and the work waiting on it — until the invocation runs out. A stop
or the invocation's deadline aborts the call and is not retried.

Reads are conditional. The manager keeps, for its whole life — one `mason
run` — the last answer to each GET URL with its `etag`
(`src/github/etag-cache.ts`, the 64 most recently used). The next read of that
URL sends `If-None-Match`; when GitHub answers 304, the kept answer is handed
back whole, as the full read would have been. A 304 sent with an
Authorization header does not count against the token's hourly budget
(GitHub's [REST best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api);
measured: three 304s in a row left `x-ratelimit-used` unchanged). So a tick
where nothing moved on the watched issues — the listing, a probe of a Ticket
in flight — costs a round trip and no budget. Handing the answer back rather
than reading a 304 as "nothing" matters: when Host did not commit its Cursor,
the same listing is asked again and the issues not consumed yet must come back.

What it does not change: the latency of a read (a 304 is still a round trip),
and anything outside this manager — `ci-green` is its own process, run once
per judgement, with nothing to remember an `etag` in. Anything this manager
writes on an issue (a comment, a label) changes the listing, so the next read
after a report is a full one.

## State labels

The Events are `invalid`, `accepted`, `progress`, `escalated`, `escalation_reminder`,
`resumed`, `submitted`, `done`, `cancelled` and `reject_late`. With `stateLabels` set,
the issue carries the label of its latest Event and the previous one is removed;
every other label (`project:`, `priority:`, yours) is never touched. `done` and
`cancelled` also keep a fresh Mason home from rebuilding or taking up an issue that
already ended, unless the resume label is on it.

`stateLabels` names every Event, with any label you like, and gives the same name to
no two Events:

```yaml
options:
  stateLabels:
    invalid: "mason:invalid"
    accepted: "mason:accepted"
    progress: "mason:progress"
    escalated: "mason:escalated"
    escalation_reminder: "mason:escalation_reminder"
    resumed: "mason:resumed"
    submitted: "mason:submitted"
    done: "termine"
    cancelled: "abandonne"
    reject_late: "mason:reject_late"
```

Absent, nothing is labelled and the guard on `done` and `cancelled` is off. Naming
an Event outside the list, leaving one out, or giving a label twice is refused.

## Label colours

`mason setup` gives each label a colour so a human can tell them apart. `labelColors`
chooses them, one label at a time. A key is the identifier of a label, never its name, so
renaming a label (`stateLabels`, `resumeLabel`, ...) does not lose its colour. A colour is
six hex digits, with or without a `#`:

```yaml
options:
  labelColors:
    feature-ready: "1d76db"
    ticket-ready: "1d76db"
    merge-when-ready: "1d76db"
    resume: "0e8a16"
    project: "c5def5" # project:<defaultProject>
    state-invalid: "5319e7"
    state-accepted: "5319e7"
    state-progress: "5319e7"
    state-escalated: "d93f0b"
    state-escalation_reminder: "d93f0b"
    state-resumed: "5319e7"
    state-submitted: "5319e7"
    state-done: "0e8a16"
    state-cancelled: "6a737d"
    state-reject_late: "6a737d"
```

Every key is optional. When the Feature and the Ticket ready labels are one label (the
same name), `feature-ready` colours it. A colour the config chose is applied to a label
that already exists too: `mason setup` says `recolour label …` and `--apply` does it. A
label the config chose no colour for keeps the default colour when it is created and is
never touched when it exists, so a colour set by hand on GitHub stays. A key that is not in
the list above, or a colour that is not six hex digits, is refused by name.

## Prepare the repository

`mason setup` reads the config and says what the repository still needs;
`--apply` creates it. It is idempotent, so it is safe to re-run after changing
the label options or setting `stateLabels`.

```bash
mason setup --apply
```

| Checked                     | How                                                                                                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The repository is reachable | `GET /repos/{owner}/{repo}` — a 404 means "not found, or this token cannot see it"                                                                                                         |
| Issues are enabled          | `has_issues` on that same response                                                                                                                                                         |
| The token can write         | `permissions.push` on that same response, rather than guessing at scopes                                                                                                                   |
| The branch exists           | `GET /repos/{owner}/{repo}/branches/{branch}` for `branch` (default `main`); when it is missing and the config named none, the step says the repository's default branch and what to write |
| Labels                      | `featureReadyLabel`, `ticketReadyLabel`, `mergeWhenReadyLabel`, `resumeLabel`, `project:<defaultProject>`, and one per Event when `stateLabels` is set                                                                                       |

Creating a label, and recolouring one the config chose a colour for (see Label
colours), are the only writes; nothing existing is renamed or deleted.

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
  manager.ts      the Manager: `features` and `tickets` (listen / adapt / report / probe live in listener/, adapter/, emitter/, probe/)
  github/         Octokit channel shared by listen, adapt, report, and probe
  probe/          whether a minted key's issue is still on the tracker
  repo.ts         owner/name
  tickets/        a Feature's sub-issues, their blockers and signals
  submission/     lines, pull requests, settled
  issue-number.ts the issue a key or a payload points at
  labels.ts       whether a payload carries a label
```
