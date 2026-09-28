# Isolation: git

Git worktree attach and three-way merge fold. Host (or a Transformer CLI) loads
this package when `workLine.isolation` is `@bluewombat/isolation-git`.

```ts
import { branchNameOf, strategy } from "@bluewombat/isolation-git";
// strategy.isolation → Isolator
// strategy.fold → Integrator
// strategy.refOf(id) → issue/<item>, what the Authority hands the Publisher:
//   issue/9 for github:owner/repo#9, issue/9-s1 for its Subtask s1,
//   issue/<slug of the id> for an id in any other shape, cut at 80 with a
//   7-hex digest of the whole id when it was cut
// branchNameOf(id) → the same, for anyone holding an id
```

The Child is a worktree of the Parent, then wiped and filled with the Parent's
working files so dirty and untracked content matches — `.cursor/`, `CLAUDE.md`,
`node_modules/`, tracked or not, all of it.

## What a Child does not get

`.env` and `.env.*`, at any depth, unless the Project says otherwise: a secret
in the clear has no business in a directory an agent reads and a pull request
may carry. A Project names its own list in the config, and that list
**replaces** the default:

```json
"workLine": {
  "isolation": "@bluewombat/isolation-git",
  "isolationOptions": { "exclude": [".env", ".env.*", "**/*.pem", "secrets/**"] }
}
```

A pattern with no `/` is matched against the last path segment, at any depth
(`.env` also leaves out `packages/api/.env`); one with a `/` against the whole
path from the root (`build/out`). `*` is any run of characters within one
segment, `**` anything, and a leading `**/` means "at any depth". An unknown
key, or an `exclude` that is not a list of non-empty strings, stops `mason
run` before it isolates anything. The copy reads no `.gitignore`: what git
ignores is very often exactly what a Builder needs (its dependencies, the
Project's own agent configuration).

Each root entry is copied by `cp` — `-c` on macOS, `--reflink=auto` elsewhere
— so on a file system that clones (APFS, btrfs, XFS) the Child shares its
bytes with the Parent instead of doubling them; where `cp` cannot, the entry
is copied by hand. Excluded paths are removed from the Child afterwards.

## What a fold keeps

The copy and the fold answer different questions. The copy decides what a
Builder can use; the fold decides what enters history. The fold snapshots a
directory the way `git add -A` would there: tracked paths — even ones
`.gitignore` matches, if someone tracked them on purpose — and new paths
`.gitignore` does not exclude. What a Builder's own build or install left
behind (`node_modules/`, `dist/`, a generated file the Project ignores) stays
on disk and out of the commit.

It starts from a copy of that directory's own index, so a removal staged and
not committed (`git rm --cached`) counts, and the directory's index is never
written to.

## The reference, and who the system is

`strategy.reference.parse` reads what a manager names as the reference work
line: `remote` and `branch`, required; `credentialEnv` and `author`, optional.
Anything else is refused. From the optional two it builds the git environment
of the run — `GIT_AUTHOR_*` / `GIT_COMMITTER_*`, and a credential helper that
reads the token from the named variable at the moment git asks, after
clearing the machine's own helpers so a keychain never answers first. Nothing
is written to disk. Every git this package spawns carries that environment,
and the parsed reference exposes it as `env` so Host can hand it to the slots
that touch the work line (Publisher, Refresher) — and to nothing else: a
Builder never inherits a token.

Without `author`, commits carry the identity of whoever runs the process.

Every process this package spawns runs with `LC_ALL=C`: what git says when an
Isolation or a fold fails becomes a report a team reads, whatever language the
machine speaks.
