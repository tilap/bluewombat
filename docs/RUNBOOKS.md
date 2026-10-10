---
title: Runbooks
summary: Pause, emergency stop, escalation, and how the packages reach npm.
covers:
  - ".github/workflows/release.yml"
  - "scripts/release.mjs"
---

# Runbooks

Written for someone tired, alone, and under pressure. Exact commands, no "simply", no
assumed context. Every runbook states how to know it worked and how to undo it.

bluewombat has no production environment or on-call rotation. The procedures below
are the operational levers from [PRODUCT.md](./PRODUCT.md) § *Bounds, leases, and stopping*,
plus how this repository's packages reach npm.

## Environments

| Environment | URL  | Deployed from | Who can deploy |
| ----------- | ---- | ------------- | -------------- |
| —           | none | —             | —              |

## Deploy

This is how `@bluewombat/*` reaches the npm registry. It is not bluewombat folding a
Feature into WorkLineStable — that has no production target.

A release is a `v*` tag on `main`. Pushing that tag runs
[`.github/workflows/release.yml`](../.github/workflows/release.yml). The workflow
checks that the tag matches every workspace package and is reachable from `main`,
runs lint, typecheck, and tests, then `node scripts/release.mjs publish`, then
opens the GitHub Release. Authentication is npm trusted publishing (the
workflow's OIDC identity). There is no `NPM_TOKEN`.

`npm publish`, `npm run release:publish`, and `node scripts/release.mjs publish`
are that workflow's step. Running any of them from a machine publishes without
the guard, the test job, or the GitHub Release. A version is cut by pushing the
tag.

`X.Y.Z` below is the version every workspace `package.json` already carries.
The tag name is `v` plus that version.

1. On `main`, `npm run release:check -- X.Y.Z` passes. To bump:
   `npm run version:set -- X.Y.Z`, then `npm install --package-lock-only`.
   Commit that and push `main`.
2. Wait until CI on that commit is green.
3. Tag that same commit and push the tag:

```bash
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

4. **Verify** — the Release workflow is green; `npm view @bluewombat/runtime version`
   prints `X.Y.Z`; a GitHub Release exists for `vX.Y.Z`.

**If it failed** — a version npm already has is skipped, not overwritten. Fix
the workflow or the trusted-publisher settings, then re-run the job. Do not
move the tag.

**A package that has never been on npm.** Trusted publishing is registered on
each package, and the package has to exist before `npm trust` can name it. The
packages already on the registry (`0.1.0` was that hand publish) do not need
this again. For a new package, from a machine where `npm login` succeeded
(2FA prompts for a one-time code):

```bash
npm publish --workspace <name> --access public
npm trust github <name> --file release.yml --repo tilap/bluewombat --allow-publish -y
```

`npm trust` is unaware of workspaces and resolves the repository root even from
a package directory, so the call names the package (npm ≥ 11.15). After that,
the tag publishes it with the others. This path does not cut a version of a
package that is already on the registry.

## Rollback

The product does not automatically revert a FeatureStandard already in WorkLineStable.
That repair is out of scope. If integration is stuck in `merging`, the human path is
escalation then `ready` → `integrating`, not abandon.

## Pause (global)

Intended behaviour when implemented:

1. **Preconditions** — you need the process to stop taking new work without crashing in-flight Subtasks.
2. **Steps** — not built. Effect: no new FeatureStandard admission, no new Subtask start; the current Subtask may finish; **no** integration into WorkLineStable.
3. **Verify** — WorkLedger shows no new `running` Subtask after the pause; FeatureEmitter does not report `done` for work that finished after the pause.
4. **If it failed** — use *Emergency stop* below.

## Emergency stop

Intended behaviour when implemented:

1. **Steps** — not built. Effect: Implementers are interrupted; affected Subtasks become `runnable`; isolated workspaces are destroyed.
2. **Verify** — no Implementer still holds a bail; WorkLedger is the only remaining state; workspaces for those Subtasks are gone.
3. **Undo** — there is no undo of destroyed workspaces. Resume is from zero on `runnable` Subtasks, consuming an Attempt.

## Incident response — escalation

The human surface is the FeatureManager, not the WorkLedger.

1. **Assess** — FeatureEmitter event `escalated`: motif, step (plan / subtask / integrating / merging), Trace if an Attempt exists, bound counters. The whole feature is frozen.
2. **Communicate** — stay in the FeatureManager. An untreated escalation stays `escalated` and should receive `escalation_reminder` events.
3. **Stabilise**
   | Lever                                | How                                                                                | Effect                                                                          |
   | ------------------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
   | `ready` after a plan escalation      | Human signal in the FeatureManager                                                 | Return to `planning`; breakdown is replayed                                     |
   | `ready` after a Subtask escalation   | Human signal in the FeatureManager                                                 | That Subtask restarts from zero; already `integrated` Subtasks are not replayed |
   | `ready` after a `merging` escalation | Human signal in the FeatureManager                                                 | Return to `integrating`. Abandon is refused                                     |
   | Abandon                              | FeatureManager, only before `merging`                                              | Feature `cancelled`; WorkSpaceFeature is never integrated                       |
   | Deleted item, poll never mentions it | Automatic on the next pass (`probe`), or `mason cancel <key>` after stopping `run` | Same as abandon. The command takes the ledger lock.                             |
4. **Record** — the Trace on the Attempt is the record. An escalation without a Trace (when an Attempt existed) is invalid.

## Work line copy diverged

`mason run` prints `work line  cannot fast-forward onto <branch>, so nothing
started` and every pass repeats it. Somebody committed into the system's copy
(`workLine.stable`, default `.mason/work-line/`), or the reference was
rewritten under it. Nothing in that copy is worth keeping — it is refetched
at every start. Either:

```bash
git -C .mason/work-line reset --hard origin/<branch>
```

or delete `.mason/work-line/` and start `mason run` again; it fetches the copy
afresh. Work in flight is untouched: the workspaces are their own worktrees.

## Rotate a leaked secret

No secrets are defined yet. When the first credential exists, the order is: revoke first,
issue a replacement, update the store and running processes, verify the old credential
is dead, assess exposure.

## Restore from backup

- Backups run: not defined
- **Last successful restore test**: never — there is no backup
- Crash recovery, when implemented, is WorkLedger reconciliation: orphan isolated
  workspaces are destroyed. That is not a backup restore.

## On call

- Rotation: none
- Escalation: the FeatureManager is the only human channel; there is no paging policy yet
