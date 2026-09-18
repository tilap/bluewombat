---
title: For dummies
summary: Plain explanations of theoretically normal pieces that are easy to get wrong — starting with git branches, worktrees, and the GitHub PR in online mode.
covers:
  - "packages/plugins/isolation-git/src/git-worktree.ts"
  - "packages/plugins/isolation-git/src/branch-name.ts"
  - "packages/kernel/isolator/src/run/run-isolator.ts"
  - "packages/host/runtime/src/loop/open-host.ts"
  - "packages/host/runtime/src/loop/tick.ts"
  - "packages/kernel/conductor/src/run/open-conductor.ts"
  - "packages/plugins/isolation-git/src/git-merge.ts"
  - "packages/host/runtime/src/loop/authority.ts"
  - "packages/plugins/slots/publishers/git.mjs"
  - "packages/plugins/slots/refreshers/git.mjs"
  - "packages/plugins/manager-github/src/submission/submission.ts"
---

# For dummies

Theoretically normal, easy to get wrong. Not SPECS. When a walkthrough here
drifts from the code, fix this file.

## Online git walkthrough (GitHub + Authority)

This is the path with a GitHub remote and Authority on. Offline (no Authority)
stops at a local fold into WorkLineStable and never opens a PR.

Specific to this path:

- There is a GitHub remote. `origin` is the product repo named in the manager
  options. Push and fetch talk to that remote only.
- Authority is on. GitHub holds `main`. bluewombat does **not** merge the feature
  into local `main`. The merge into `main` is the pull request on GitHub.
- WorkLineStable is a local clone of that repo, left on `main`. Work does not
  happen in that checkout. Host declares `workLine.isolation: "@bluewombat/isolation-git"`
  (a package specifier — not an alias, not Isolator sniffing `.git`). Isolator adds
  **worktrees** (a second directory on another branch). `work-line-stable` stays on `main`.
- The Publisher pushes the feature branch. The GitHub manager opens the PR
  (`head` = that branch, `base` = `main`) and later merges it.
- After GitHub merges, the next pass fetches `origin/main` and fast-forwards
  the local clone. That is the only way local `main` moves.

### Feature

Parent = WorkLineStable (HEAD = `main`).

```
git worktree add -B issue/<id> <workspace-feature>
```

A feature branch is created from the current commit of `main`.

### Task

Parent = that feature workspace.

```
git worktree add -B issue/<id-task> <workspace-task>
```

A task branch is created from the feature.

### After the task is built

Integrator merges the task into the feature (`merge-tree` + a commit on the
feature). Then the task directory is destroyed.

Repeat for each task.

### Before the PR

Merge `main` into the feature (align), so the feature is up to date if `main`
moved while the tasks ran. Then:

```
git push origin issue/<id>
```

### PR

- `head` = that feature branch
- `base` = `main`
