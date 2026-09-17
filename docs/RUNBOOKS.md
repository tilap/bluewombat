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

mason has no production environment or on-call rotation. The procedures below
are the operational levers from [PRODUCT.md](./PRODUCT.md) § *Bounds, leases, and stopping*,
plus how this repository's packages reach npm.

## Environments

| Environment | URL  | Deployed from | Who can deploy |
| ----------- | ---- | ------------- | -------------- |
| —           | none | —             | —              |

## Deploy

This is how `@bluewombat/*` reaches the npm registry. It is not mason folding a
Feature into WorkLineStable — that has no production target.

The tag is the trigger. `v0.1.0` publishes every workspace package at `0.1.0`.
The workflow authenticates with npm trusted publishing (OIDC), not a secret.

**Once, at the first release.** The publisher is configured *on each package*,
so the package has to exist before the workflow can publish it. From a machine
where `npm login` succeeded (2FA prompts for a one-time code):

```bash
nvm use
npm ci
npm test
npm run build
npm publish --workspaces --access public
```

Then register the workflow as the publisher of every package (`npm trust` is
unaware of workspaces, hence one call per directory; npm ≥ 11.15; 2FA prompts
on the first call only):

```bash
for d in packages/*/*/; do (cd "$d" && npm trust github --file release.yml --repo tilap/bluewombat --allow-publish -y); done
```

No token is stored anywhere. Every later release is the tag alone.

**Verify** — `npm view @bluewombat/runtime version` prints `0.1.0`, and
`npm trust list @bluewombat/runtime` shows `tilap/bluewombat` / `release.yml`.

**Later releases.**

1. On `main`, every workspace package already carries the version you will tag
   (`npm run release:check -- 0.1.0`). To bump: `npm run version:set -- 0.2.0`
   then `npm install --package-lock-only`.
2. Push `main`. Wait until CI on that commit is green.
3. Tag the same commit and push the tag:

```bash
git tag -a v0.1.0 -m "v0.1.0"
git push origin v0.1.0
```

4. **Verify** — the Release workflow is green; `npm view @bluewombat/runtime version`
   matches the tag; a GitHub Release exists for `v0.1.0`.

**If it failed** — a version npm already has is skipped, not overwritten. Fix
the workflow or the trusted-publisher settings, then re-run the job. Do not
move the tag.

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
