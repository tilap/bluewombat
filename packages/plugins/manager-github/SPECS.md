# Manager: GitHub Issues

A plugin, not a Transformer. GitHub Issues in, issue comments (and optional
state labels) out, as one `ManagerPort`. Listen / adapt / report live in this
package. GitHub-the-git-host is out of scope — only the tracker.

## 1. Job

```
  Host                          manager-github
  ----                          --------------
  managerOptions                read repo / labels / token
  a Cursor                      poll the issue list
  a key                         probe: is the issue still there
  one semantic Event            comment, and maybe label
  a published branch            submit: open (or reuse) the pull request
  a Submission reference        fold: squash-merge it, delete the branch unless keepBranch
                            ←   ManagerPort
```

**In:** a `ManagerContext`. **Out:** a `ManagerPort`, or a reason.

## 2. The token

Read from `context.env[tokenEnv]`, defaulting to `GITHUB_TOKEN`. A `token`
option exists for embedding and tests. `createManager` refuses with the name of
the variable it wanted when neither is set — the value is never echoed, logged,
or written to a Thread.

## 3. Keys

`github:<owner>/<name>#<issue>`, or `github:unconvertible` when the payload
carries no issue number. `report` recovers the issue from the key: every key
this package mints ends in `#<issue>`, so no issue number crosses the Port.

## 3b. The intention and its fingerprint

The issue body is the intention, verbatim, less what the tracker itself put
there: the HTML comments an issue template leaves behind, and the boxes of a
task list (`- [ ]`, `- [x]` — the bullet and the words stay). Line ends are
normalised, trailing blanks and runs of blank lines collapsed. Nothing is read:
no criteria, no headings, no meaning. A body that was only that falls back to
the title, like no body at all.

The FeatureStandard's `fingerprint` hashes that intention with the title, the
project and the priority. It is what tells an **edit** from an **echo** — a
comment or a state label moves `updated_at` and delivers the issue again, and
so does a human ticking a box. None of those is a change of mind, so none of
them changes the fingerprint; a different fingerprint on a Feature in flight
is recorded as pending and freezes it once the current unit lands
(PRODUCT.md, "An intention edited while in flight"). Rewording the body is an
edit. Ticking a box is not.

## 4. Ready

`signalsReady` is true when the payload carries `readyLabel`, ignoring case, in
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
(`fail` when it is not), whether labels narrow the Source (`warn` when they do
not — every open issue would be admitted), and reminds which labels the
repository needs. It never calls the API: the answer must be the same offline.

## 6. Init

`scaffoldManager` fills `repo`, `tokenEnv`, `labels`, `readyLabel` and
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

## 8. Acceptance

1. A token in the variable named by `tokenEnv` is enough to build the Port.
2. No token → a reason naming the variable it looked in.
3. A missing `repo`, a `repo` that is not `owner/name`, and an unknown option
   key each return a reason.
4. `checkManager` fails on a missing token and warns when no label is set.
5. `setup` without `apply` writes nothing; with `apply` it creates only the
   missing labels, and a second `apply` writes nothing at all.
6. Disabled issues, a read-only token, and an unreachable repository each block
   before any label is created.
7. `scaffoldManager` keeps a `repo` it was given and names `GITHUB_TOKEN`.
8. `invalid`, `accepted`, `planned`, `escalated` and `resumed` comments are
   written as string literals, not a field dump. An `invalid` comment is the
   heading and the reason as a paragraph, with no `- reason:` bullet.
9. `probe` of an open issue is `present`; closed or 404 is `gone`; 403 is
   `unavailable`. A key with no issue number does not call the API.
10. A template's HTML comments and a task list's boxes leave the intention;
    the bullet and the words stay. The same body with a box ticked normalises
    to the same intention and the same fingerprint. A body that was only
    noise falls back to the title.
11. `setup` blocks on a `branch` the repository does not have, and names the
    repository's default branch when the config named none.

How to build and configure: [README.md](./README.md).
