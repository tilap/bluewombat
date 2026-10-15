# Manager: GitHub Issues

A plugin, not a Transformer. GitHub Issues in (Features and their sub-issues),
issue comments (and optional state labels) out, and the lines and pull requests
of the same repository, as one `Manager` (`features` and `tickets`). Listen /
adapt / report live in this package.

## 1. Job

```
  Host                          manager-github
  ----                          --------------
  managerOptions                read repo / labels / token
  a Cursor                      poll the issues labelled feature-ready
  a Feature                     list its sub-issues and blockers
  a key                         probe: is the issue still there
  one semantic Event            comment, and maybe label
  a Feature's line              openLine: cut feature/<n>; dropLine
  a published branch            submit: open (or reuse) the pull request
  a Submission reference        fold: squash-merge it, delete the branch unless keepBranch;
                                settled: open / folded / closed
                            ←   Manager
```

**In:** a `ManagerContext`. **Out:** a `Manager`, or a reason.

## 2. The token

Read from `context.env[tokenEnv]`, defaulting to `GITHUB_TOKEN`. A `token`
option exists for embedding and tests. `createManager` refuses with the name of
the variable it wanted when neither is set — the value is never echoed, logged,
or written to a Thread.

## 3. Keys

Features and Tickets share one spelling: `github:<owner>/<name>#<issue>`, or `github:unconvertible` when the payload
carries no issue number. `report` recovers the issue from the key: every key
this package mints ends in `#<issue>`, so no issue number crosses the Port.

## 3b. The intention and its fingerprint

The issue body is the intention, verbatim, less what the tracker itself put
there: the HTML comments an issue template leaves behind, and the boxes of a
task list (`- [ ]`, `- [x]` — the bullet and the words stay). Line ends are
normalised, trailing blanks and runs of blank lines collapsed. Nothing is read:
no criteria, no headings, no meaning. A body that was only that falls back to
the title, like no body at all.

The FeatureStandard's and TicketStandard's `fingerprint` hashes that intention with the title, the
project and the priority. It is what tells an **edit** from an **echo** — a
comment or a state label moves `updated_at` and delivers the issue again, and
so does a human ticking a box. None of those is a change of mind, so none of
them changes the fingerprint; a different fingerprint on a Ticket in flight
is recorded as pending and freezes it once the current unit lands
(PRODUCT.md, "An intention edited while in flight"). Rewording the body is an
edit. Ticking a box is not.

## 3c. Features and Tickets

A Feature is listed when the issue has no parent (`parent_issue_url` is null) and carries `featureReadyLabel`
(`labels=<featureReadyLabel>` on the list call). Its `blocked_by` are read from
`GET /issues/{n}/dependencies/blocked_by`, its `merge_when_ready` from
`mergeWhenReadyLabel`. `tickets(feature)` reads `GET /issues/{n}/sub_issues`
and, per sub-issue, its blockers; `task_ready` is `ticketReadyLabel`, `resume` is
`resumeLabel`, `open` is the issue state. Every failed read is `unavailable`,
never an empty list.

## 4. Resume

`signalsResume` is true when the payload carries `resumeLabel`, ignoring case, in
either label spelling GitHub uses (a string, or an object with `name`). A poll
returns a snapshot with no `labeled` edge, so the label on the snapshot is the
only signal there is.

## 5. Setup

`setupManager` is the only part of this package that writes to GitHub before a
run. It reads the repository once — that single response answers reachable,
issues enabled, and whether the token may write — then lists the labels the
configuration names against the labels that exist.

Without `apply` it reports a plan and sends no `POST`. With `apply` it creates
the missing labels and nothing else: an existing label is never renamed,
recoloured, or deleted, and a repeated name is created once. A second `apply`
reports everything `satisfied`.

A 404 on the repository is reported as "not found, or this token cannot see
it", because from here the two are the same answer.

## 6. Doctor

`checkManager` reports the repository, whether the token variable is set
(`fail` when it is not), and names the labels the repository needs (`featureReadyLabel`,
`ticketReadyLabel`, `mergeWhenReadyLabel`, `resumeLabel`). It never calls the API: the answer must be the same offline.

## 6. Init

`scaffoldManager` fills `repo`, `tokenEnv`, `resumeLabel` and
`defaultProject`. It does not create labels on the repository: that needs the
network, and the operator still owns the tracker. A `repo` already in
`managerOptions` is kept.

## 7. Probe

`probe` recovers the issue from the key (`github:<owner>/<name>#<n>`) and
`GET`s it. Open is `present`. Closed is `gone` — the same intent as a cancel
delivery. A 404 or 410 is `gone` too (deleted, or transferred). Anything else
— a 401, a 403, a 5xx, a body that is not an issue — is `unavailable`. A key
with no issue number is `unavailable`, not `gone`.

`fetchIssue` still treats every failure as `unavailable`: a Fetch that did
not answer says nothing about the intention being converted. Probe is the
path that may read a 404 as absence.

## 7b. Lines

`openLine({line, from})` reads `git/ref/heads/<from>` and creates `refs/heads/<line>`
at that commit; a 422 (the ref exists) is a success. `dropLine` deletes the ref
and ignores a refusal. `settled({reference})` reads the pull request: merged is
`folded`, closed unmerged is `closed`, otherwise `open`.

## 8. Acceptance

1. A token in the variable named by `tokenEnv` is enough to build the Port.
2. No token → a reason naming the variable it looked in.
3. A missing `repo`, a `repo` that is not `owner/name`, and an unknown option
   key each return a reason.
4. `checkManager` fails on a missing token and names the four labels.
5. `setup` without `apply` writes nothing; with `apply` it creates only the
   missing labels, and a second `apply` writes nothing at all.
6. Disabled issues, a read-only token, and an unreachable repository each block
   before any label is created.
7. `scaffoldManager` keeps a `repo` it was given and names `GITHUB_TOKEN`.
8. `invalid`, `accepted`, `escalated`, `escalation_reminder` and
   `resumed` comments are written as string literals, not a field dump. An
   `invalid` comment is the heading and the reason as a paragraph, with no
   `- reason:` bullet.
9. `probe` of an open issue is `present`; closed or 404 is `gone`; 403 is
   `unavailable`. A key with no issue number does not call the API.
10. A template's HTML comments and a task list's boxes leave the intention;
    the bullet and the words stay. The same body with a box ticked normalises
    to the same intention and the same fingerprint. A body that was only
    noise falls back to the title.
11. `setup` blocks on a `branch` the repository does not have, and names the
    repository's default branch when the config named none.
12. An `escalated` comment says what a human can do from the issue, in this
    tracker's gestures: add `resumeLabel` to resume, close the issue to
    abandon — and, for an escalation born in `merging`, only the first, since
    a close there is refused. An `escalation_reminder` is the same comment
    under "Still escalated": same diagnosis, same answers.
13. A Trace renders the same under every Event that carries one: a `Trace`
    heading, one line saying it is the stopping step's own words written for
    the agent that repairs it, then the text fenced and folded at 80 columns.

14. A Feature is listed only with `featureReadyLabel`; its Tickets are its sub-issues;
    a blocker read that fails is `unavailable`, never an empty list.
15. `openLine` of an existing line succeeds; `settled` distinguishes a merge
    from a close.

How to build and configure: [README.md](./README.md).