---
title: Reservations
summary: What is not settled — calls made without agreement, defects found and left, code never run for real, and what would be better.
covers: []
---

# Reservations

The complement of [DECISIONS.md](./DECISIONS.md). That file holds what was
settled; this one holds what was not.

An entry here is a thing someone should look at again. It is not a bug tracker
and not a backlog: it is the list of places where the code says one thing and
nobody agreed to it, or where it was never proved.

## How to use it

**Add an entry when any of these is true.** Do it in the same change that
creates the situation, not later.

| You did this                                                     | Section |
| ---------------------------------------------------------------- | ------- |
| Made a call the person you work with never validated             | `C`     |
| Found a defect, a gap, or something illogical you are not fixing | `F`     |
| Shipped code you never saw run against the real thing            | `U`     |
| Left something working but worse than it could be                | `I`     |

**Remove an entry when it is settled** — and if it was a choice, record the
settlement in [DECISIONS.md](./DECISIONS.md) as you go. An entry that leaves
this file without landing there was never really decided.

Each entry carries an id (`C1`, `F2`, …) so it can be named in a conversation, a
commit, or an issue. Ids are never reused.

Every entry has the same three parts: **where**, **what**, and — for a choice —
**instead**, naming the alternative that was on the table. An entry with no
location is not actionable; an entry with no alternative is not a choice, it is
a fault.

---

## C — Calls made without agreement

### C5 · `worktree add -B` resets the branch on every Isolation

`packages/plugins/isolation-git/src/git-worktree.ts` — `addGitWorktree`

`-B` keeps Isolator's contract exactly: the Child is a snapshot of the Parent,
never the leftovers of an earlier run. But the Submission flow wants the feature
branch to *keep* receiving commits across refusals. Today the two do not collide
because a refusal returns the feature to `integrating` without re-isolating —
the branch survives. **If a resume ever re-isolates a feature that already has a
Submission, that Submission's history is reset under it.** Nothing prevents that
today.

**Instead:** name the branch only when it does not exist, and let a resume decide
explicitly whether it is continuing or starting over.

### C7 · The work line copy is refreshed on every driving pass

`packages/host/runtime/src/loop/tick.ts` — `runOnce`

A pass with nothing to drive fetches nothing. A pass that drives does a
`git fetch` per run, whether or not anything was folded since the last one.
Cheap and always correct, and noisy on a short poll interval.

"Something to drive" counts a `received` Feature (`pendingWork`, `SWEEP_STATES`)
— so a Feature queued behind an `escalated` one, which the sweep will not
drive, still costs a fetch on every tick for as long as the human takes to
answer. **Observed** 2026-09-14 (#27 behind #26) and 2026-09-16 (#38 behind
#37): one `refresh` line per tick, nothing driven.

**Instead:** refresh only after an accepted Submission, which needs the tick to
know that one happened; or leave `received` out of the refresh guard and let
the sweep refresh on the tick it actually starts one.

### C8 · A refresh that cannot fast-forward stops the whole pass

`packages/host/runtime/src/loop/tick.ts` — `runOnce`

Every Project stops, not only the one whose work line diverged. Starting work on
a copy that could not be brought up to date builds on a version that no longer
exists, so stopping is right; stopping *everything* is broader than the problem.

**Instead:** scope it to the Project that owns that work line, once a Project
owns its own.

### C11 · The Submission reference is a URL, parsed back with a regular expression

`packages/plugins/manager-github/src/submission/submission.ts` — `numberFromReference`

One field carries both the identity and what a human reads. A reference the
manager did not mint — hand-edited, or from another host — silently becomes
`unavailable`.

**Instead:** keep the identity and the display apart in the record.

### C13 · The Gate order in the shipped example

`packages/plugins/slots/README.md` (the example config), and the trial
project's `mason.config.yaml`

`workspace-changed` → `parent-clean` → `sensitive-path` → `npm-test`: cheapest
and most structural first, the Project's own check last. Defensible, never
agreed. At the assembly stage, `gitignore-leak` before `ci-green` for the same
reason: a local answer in a second before a wait on CI.

### C16 · Where a failing job's log is cut

`packages/plugins/slots/gates/ci-green.mjs` — `logOf`

A job's log is the whole run: the runner provisioning itself, every step that
passed, then the cleanup. On four real failures it was 20-33 KB, of which two
lines said what was wrong. The report is read by the producer of the next
Attempt, and by a human on the issue; neither is served by the rest.

The cut follows the runner's own structure: from the last `##[group]Run ` before
the failure to the `##[error]` that marks it — the failing step, and nothing
else. Measured over those four failures: 96.5% to 99.2% smaller, 6 to 17 lines.

The alternative, and what was there first, is a fixed window of the last N lines.
It needs a number nobody can justify, and it cuts by position rather than by
meaning: a step that prints more than N lines before failing loses its own
opening, and a step that prints fewer picks up the tail of the step before it.

What this choice costs: a failure whose cause is in an *earlier* step that did
not stop the job is not in the report, and a step that fails without the runner
marking `##[error]` — cancelled, or killed from outside — falls back to the last
step that ran, which is a guess.

### C17 · The slot's bounds became the Project's to write

`packages/host/slot-kit/src/prompt.ts` — `PROMPT_RULES`, `--rules-file`

`{{rules}}` used to be fixed in code, on the reasoning that it is not a matter
of taste: the Gates read the working tree of one directory, so an agent that
commits, stashes or writes elsewhere leaves them nothing to see. A Project can
now replace the whole list.

Asked for, and consistent with the prompts being the Project's. What it costs:
nothing stops a Project's `--rules-file` dropping "do not commit", and the
failure that follows is silent in the wrong place — the agent works, the Gate
says nothing changed, the Attempt is refused for having done nothing. The rule
still holds; only the sentence saying so is gone. (Leaving `{{rules}}` out of
the template altogether is no longer possible: the role refuses before the
agent runs.)

An alternative was a fixed preamble the Project could only add to. It was not
taken because the same argument would then apply to the prompt templates, which
are already the Project's entirely.

### C18 · What a transcript keeps, and what it never keeps

`packages/host/slot-kit/src/transcript.ts` — `openTranscript`

One Markdown file per turn — invocation, prompt, stdout, stderr, timing — filed
under the Feature. Off unless `--transcript-dir` is given.

Off by default because the content is the Project's own material in the clear.
One file per turn rather than a stream, because the pair that has to be read
together is a prompt and what came back; a shared log interleaves turns and the
pairing is lost.

What it does not keep, deliberately: a Gate's raw output — the Gate's report is
already in the journal, and the raw log is a one-off investigation. What it also
does not keep, not deliberately: the durations of the Gates. They are derivable
from the journal's `at` stamps, which is not the same as being written down.

Rotation is nobody's job. A long-running Project accumulates one file per turn
forever, and nothing prunes them.

### C20 · A queued Feature behind a `submitted` one waits until the next tick

`packages/host/runtime/src/loop/tick.ts` — `driven`

A pass that admits B while A is `submitted` drives A (the active one) and
marks the Project driven, so the sweep skips B. B starts on the next pass,
one `pollIntervalMs` later. Driving twice in the same tick would start B the
moment A became `done`, at the cost of two `runProject` calls and a second
work-line refresh question.

**Instead:** when `runProject` returns a terminal outcome, drive the same
Project again in that pass until it is idle or frozen.

### C21 · `assembly/validate.mjs`'s verdict is a `MASON_VERDICT:` line the slot parses

`packages/plugins/slots/assembly/validate.mjs` — `answer`, `lastVerdictLine`

Nothing upstream of this change said how a read-only reviewer tells the slot
its verdict — only that `finishRun`'s exit-0-is-a-pass shortcut is wrong for
it and that the mapping goes through `emitFailure` instead. This protocol was
invented here, and revised once already from what a real run showed:

The first cut asked the agent to answer with exactly `VALIDATED` or
`REFUSED: <paragraph>`, matched at the start of the answer. Run for real
against `tilap/mason-test` (2026-09-24), the agent reasoned out loud first —
`"I'll review the assembled feature… — read-only, no changes.VALIDATED"` —
and the anchored match missed it, parking a refusal that named nothing wrong.
A bare "search anywhere" fix was rejected in review: a model's own reasoning
can use either word by accident ("the units were already validated on their
own"), and a repository could have code or docs where that collides for real.

Shipped instead: the agent ends its final message with one line,
`MASON_VERDICT: VALIDATED` or `MASON_VERDICT: REFUSED: <paragraph, one
line>`; the slot reads the **last** line starting with `MASON_VERDICT:`
(case-insensitive, anchored to the line start) and ignores everything else,
including the same words loose in a preamble. Tested against that real
transcript (as a fixture) and against a synthetic answer that uses both
words in unrelated sentences before the marker line.

Still open: every future validate prompt (the shipped one and any Project's
`--prompt-file`) now has to place `MASON_VERDICT:` correctly, and a model
that never writes that exact line is treated as a malformed refusal. Only
one real agent CLI (Cursor) has exercised this path so far.

**Instead:** a structured verdict on a side channel (a JSON file the slot reads
after the agent exits, the way a Gate's own JSON line works).

### C22 · `recordParkedRefusal` / `clearParkedRefusal` are two WorkLedger commands, not one

`packages/kernel/work-ledger/src/ledger/open-work-ledger.ts`

The source spec for this change describes "a command that writes that report
… and increments the counter. Clearing it when validate accepts" in one
breath, which could read as a single command (report present → record,
absent → clear). Implemented here as two commands instead, matching the
existing shape of `recordRefusal` and `clearWorkspace` as separate verbs
(§17.2 of `work-ledger/SPECS.md`: "Commands, not `set(state)`"). Behaviourally
equivalent either way; the two-command shape was picked for test clarity, not
verified against the author's intent.

**Instead:** one command, `report?: string` present or absent deciding record
vs. clear.

---

## F — Faults found and left

### F6 · RUNBOOKS.md says there are no secrets

`docs/RUNBOOKS.md` — "Rotate a leaked secret"

False since `GITHUB_TOKEN`, and more so now that an agent CLI's credentials sit
in the same environment. The rotation procedure is a placeholder.

### F9 · Two Gates depend on an unstated rule

`packages/plugins/slots/gates/sensitive-path.mjs` compares the workspace against
`HEAD`, so a Builder that commits its work makes the Gate blind.
`workspace-changed` catches that today, by refusing a workspace with nothing
uncommitted. The coupling is real and written only in prose.

### F18 · A producer that ignores its report is not caught

`packages/plugins/slots/builders/repair.mjs` — a producing pass with `--report`

Nothing in the system notices a producing pass that answers a report without
addressing it: `workspace-changed` only asks whether *something* changed, and
a pass that changed something for no reason passes it just the same.

The sighting that opened this entry was misread: the agent had made the
repair, and a fold that ran before the producing pass published it a round
late, so the same report came back unchanged (fixed; see DECISIONS, "A repair
produces before the Integration"). From outside, "the agent did nothing" and
"the agent's work was published a round late" produce the same repeated
report; only the transcript told them apart. Keep this as a gap, not as a
sighting — it is not assertable by a test, an agent being what it is.

### F13 · A lost WorkLedger makes bluewombat redo finished work

`packages/host/runtime/src/loop/deliveries.ts` — `handleUpsert`, `IN_FLIGHT_OR_TERMINAL`

The WorkLedger is the only memory. With it gone, every open issue that still
carries the admission labels is admitted again and rebuilt from scratch, even
though the tracker already says `mason:done` on it and the work is merged.
**Observed**: a wiped ledger started rebuilding four features that
were already merged, and would have opened a pull request for each.

*Mitigated:* the GitHub listener no longer delivers an issue that
already carries the `done` state label, unless the resume signal is on it too.
The WorkLedger stays the source of truth; the tracker's own memory is now read
as a guard against rebuilding what is already merged. It only works when
`stateLabelPrefix` is set, and a tracker with no state of its own has no such
guard.

### F12 · `parent-clean` compares a copy Parent by modification time

`packages/plugins/slots/gates/parent-clean.mjs` — `leaksIn`, `referenceTime`

With no `.git` on the Parent there is no baseline, so the Gate takes the
workspace's oldest file as a reference time. A heuristic, and it is the only
thing standing between a copy-mode Parent and an undetected leak.

### F23 · A Child costs a full copy of the Parent, `node_modules` included

`packages/plugins/isolation-git/src/copy-working-files.ts` — `copyWorkingFiles`;
`packages/kernel/integrator/src/fold/working-files.ts` — `snapshotWorkingFiles`

The Child is the Parent's working files, whatever `.gitignore` says. That is
deliberate: `.cursor/mcp.json`, `CLAUDE.md` and the dependencies reach the
Builder because of it, and a copy of tracked files alone would read as an agent
that quietly got worse. What rode along uninvited — secrets — is settled:
`.env` and `.env.*` never reach a Child, and a Project names its own list
(`workLine.isolationOptions.exclude`, DECISIONS). What remains is the cost.

**Measured** on a real `node_modules` (11 654 files, 214 MB): the hand copy took
6 s; the `cp -c` clone the plugin now uses takes 3.7 s and **0 MB** on APFS —
the bytes are shared. So the disk cost is gone where the file system clones,
and the time is per-file syscalls, 2n + 2 times per Feature: one Isolation
into the Feature workspace, one Isolation and one fold snapshot per Subtask,
one fold snapshot of the work line. The Integrator's snapshot is the kernel's
own hand copy and knows nothing of `cp`.

Excluding `node_modules` through the list is not the answer as it stands: the
Gates run in the Child, and a Child with no dependencies fail-blocks on
`npm-test` (I5). It becomes one the day a Project can say how a Child gets
its dependencies (an install step, a link to the Parent's).

**Instead:** let the fold backend restore the Parent itself (git can), and drop
the kernel snapshot for the git strategy; then a way for a Project to exclude
`node_modules` and still run its Gates.

### F25 · A cancel during `submitted` leaves the pull request open

`packages/host/runtime/src/loop/deliveries.ts` — `handleCancel`;
`packages/kernel/conductor/src/run/open-conductor.ts` — `cancel`

Abandoning a Feature that has a Submission destroys its workspaces and marks
the record `cancelled`; nothing tells the Authority. The pull request stays
open, on a branch nobody will push to again, until a person closes it.
**Observed** twice, #32 on 2026-09-14 and #47 on 2026-09-16, both closed by
hand after the run. The Manager Port has `submit` and `fold` and no way to
withdraw; the record keeps `submission.reference`, so the information is
there.

**Instead:** a third optional Authority method, `withdraw(reference)`, called
from `handleCancel` when the record carries a Submission — the GitHub one
closes the pull request and deletes the branch unless `keepBranch`; or leave
it, and say so on the `cancelled` comment ("the pull request is yours to
close").

### F15 · A Gate's report reaches the producer, an Authority's did not

`packages/host/runtime/src/loop/bricks.ts` — `implement`

Conductor passed the refusal report in `ImplementInput`, and `create-bricks`
built the Implementer invocation without it. The report was recorded in the
WorkLedger, shown on the tracker, and never reached the prompt: every Attempt
after a refusal repeated blind.

It survived because `ImplementInput` did not declare the field, so nothing
complained, and the Conductor test used a fake port that read it directly. Kept
here as a warning about the shape: a port whose type is looser than its callers
hides exactly this.

---

### F26 · A Submission carries every commit the feature workspace ever made

`packages/plugins/slots/publishers/git.mjs` — a plain push of the feature
branch; `packages/plugins/isolation-git/src/git-merge.ts` — each fold and
align adds history, never rewrites it

What reaches the Authority is the branch, history and all. A blob that entered
it once is pushed even after a later commit removed it: seen live, a feature
whose first fold had committed a Builder's install (1 531 files, a 17 MB
`libvips` and a 10 MB `esbuild` binary) still had a 17 MB pack to push after
the repair took them out, and every push failed mid-way (`RPC failed; HTTP
400`, `unexpected disconnect while reading sideband packet`) while the same
token's API calls kept working. The pack's size over HTTPS is the likely
cause, not a proved one. The pull request is squash-merged, so the work line stays clean;
the branch and the push do not. The fold now keeps ignored paths out of
history (DECISIONS), which closes the way this happened, not the class.

**Instead:** publish one commit per Submission — the feature's tree on the
work line's head — rather than the workspace's history; or refuse, before the
push, a branch whose history holds what its tip does not.

### F28 · A SIGKILL on `mason run` leaves its children running

`scripts/templates/process-tree.ts` — `track`

Every supervised child leads a group of its own, so it no longer shares the
terminal's Ctrl-C. Their only reaper is the `exit` hook of the process that
started them, and a SIGKILL runs no hook: an agent at work, and what it
started, run on until they end by themselves. SIGINT / SIGTERM end them (seen
for real: an assembly fix and its `pnpm test`, gone within a second). Nothing
in a process can survive its own SIGKILL; only an outside reaper — a
supervisor around `mason run`, or a sweep of `.mason/` at start-up — could.

### F29 · A killed Attempt leaves no transcript

`packages/host/slot-kit/src/transcript.ts` — `openTranscript`

The page is written once, when the agent returns. An agent killed at its
ceiling or by an interrupt never returns, so the Attempt worth reading most
has no transcript. With `observability.streams` on, its raw output is filmed
as it arrives and covers the gap; off — the default — nothing is kept.

### F30 · The walk down the tree has two ways out

`scripts/templates/process-tree.ts` — `descendants`, `killTree`

A kill reads the descendants from `ps -A -o pid=,ppid=` before signalling and
kills each one as well as the group: cursor-agent starts each shell command in
a group of its own, out of the group kill's reach (seen: `pnpm test` → vitest,
ended with the agent on an interrupt). Two escapes remain by construction: a
process started between the `ps` read and the kill, and one that daemonised —
re-parented to init — before it. **Instead**: a per-run cgroup (Linux) or a
job object (Windows) would hold every descendant; neither is portable.

## U — Never run against the real thing

Everything here is covered by tests. None of it has been seen working outside
them.

### U2 · `fold` refusing

`packages/plugins/manager-github/src/submission/submission.ts` — the 405 / 409 branch.
A pull request that cannot be merged has never been seen.

### U3 · `submit` refusing permanently

Same file. The branch that turns a permanent API failure into an escalation has
never fired.

### U4 · Copy mode, with everything added since

A WorkLineStable with no `.git`: `workspace-changed` and `sensitive-path` both
fail-block there, Isolator names no branch, and a Submission is refused outright.
That whole combination is untested and probably unusable as it stands.

### U7 · `reject_late`

Cancel has run for real on a `received`, an `escalated` and a `submitted`
Feature (#31 and #46: closed seconds after `## Submitted`, `cancelled` on the
next tick, the Project free). The point of no return — a cancel arriving in
`merging` or on a `done` Feature, and the `reject_late` it must answer — has
only run in unit tests.

### U8 · An interrupt during `submitted`

SIGINT while a feature waits for a verdict.

### U9 · Two Projects at once

One Project has ever run.

### U10 · The `--work-line-branch` flag

Only the config key was exercised. The flag shares its code path, and was never
typed.

### U11 · No test runs the shipped Gates against a real Authority any more

`integration/03-host-authority-slots` was the one assembly with a real Host on a
real git work line, a FeatureManager that was also the Authority, and the
**shipped** Gates — no stub anywhere. It was deleted with `integration/`. It
guarded two defects by putting them back: the fold before the producing pass,
and `workspace-changed` blind to the stage (both fixed since, both now rows in
DECISIONS). What remains:
`packages/host/runtime/src/loop/open-host-authority.test.ts` (real Host, fake
manager, publisher and refresher stubbed by a one-line script) and
`authority.test.ts` (the real `publish` / `refreshWorkLine` against a bare git
remote, single-branch — the shape that made `--force-with-lease` reject every
republish). The half those two leave out is a Submission judged from outside by
the shipped Gates. Nothing gates a commit on it.

The GitHub round trip — issue in, comments, labels, pull request, merge, then
the red variant — is written down as a five-scenario checklist in the trial
project (`ttt/test-online/E2E_TESTS.md`, outside this repository), and was run
in full on 2026-09-14 and 2026-09-16 with the shipped Gates and GitHub as the
Authority (`test-results/2026-09-1{4,6}-e2e-run.md` there). It is a checklist
a person follows, not a script under version control here, and nothing gates
a commit on it. The first run found the refusal path broken (an echo of
`## Submitted` admitted as an edit), which is exactly what this entry says
goes unseen.

The thing learnt the hard way, so it is not reinvented: a CI rule the agent
can read in the repository proves nothing — it satisfies it before the first
push (a Node-version pin was polyfilled around, #40), and a rule keyed on the
run number never goes green (push and pull_request both fire). What works is a
rule the agent cannot anticipate but can satisfy once told — require
`refs #<pull request number>` in the changelog; the number does not exist
until the pull request does, the failing log states it, the second round
passes. That rule is now the trial repository's own CI, so every run there
pays one refusal round.

### U12 · Trusted publishing, never fired

`.github/workflows/release.yml`, `scripts/release.mjs` `publish`

The workflow, the skip-if-already-published loop, and the GitHub Release step
have never run. `npm trust github` has never been run for the sixteen
packages. The by-hand first publish has never been done from this repository.

### U13 · A fold from a copy of the directory's index

`packages/plugins/isolation-git/src/git-merge.ts` — `writeWorkingTreeCommit`,
`seedIndex`

Covered by `fold.test.ts` (an ignored build output stays out, a path tracked
under an ignored directory stays in, a staged `git rm --cached` counts). The
live run that found the leak ran the earlier `-f` fold, then a version with an
empty index; this one has not folded a real feature yet. Unproved outside the
tests: a Child whose index git cannot read from a copy (`core.splitIndex`, a
`sparse` index) — git resolves a shared index against `$GIT_DIR`, so it should
hold, and nothing checks it.

### U14 · `gitignore-leak` on a real Submission

`packages/plugins/slots/gates/gitignore-leak.mjs`

Covered by `test/gates.test.ts` against throwaway repositories. It has never
judged a real assembled feature, and its `--base` has only ever been a local
`main`: a work line whose branch is not named the same in the feature
workspace (a copy that fetched only `origin/main`) would fail-block it, which
is loud, but untried.

---

### U15 · A report held the work for five minutes, cause unproved

`packages/plugins/manager-github/src/github/client.ts` — `boundedFetch`; `packages/host/runtime/src/loop/report.ts` — `pushReport`

On `tilap/orangemonkey-site#5` the "In progress" comment was posted five
minutes after the Subtask it reports on landed; nothing else ran meanwhile,
and the report is awaited where the work is. A silent connection is the
likely cause (a plain request to the same API hung over two minutes that
evening), a secondary rate-limit wait the other one; the journal could not
tell. Each attempt now has a 30-second clock and is retried, and every report
is filmed with its duration, so the next one shows. 30 seconds is a guess no
measurement backs. **Instead**: reports off the critical path — queued and
sent beside the work — would make any wait harmless, at the cost of ordering
the tracker's comments by hand.

## I — Working, and worse than it could be

### I4 · `ci-green` polling has no backoff

`packages/plugins/slots/gates/ci-green.mjs` — `--poll-ms`

One set of API calls per poll per waiting feature, at the same rate whether the
checks started a second ago or ten minutes ago.

### I5 · The `npm-test` Gate cannot install dependencies

The trial project's `gates/npm-test.mjs` (not shipped)

It fail-blocks with a clear message when a workspace has dependencies and no
`node_modules`, which is honest but leaves the operator to solve it. Isolator
does not carry an ignored directory across, so somebody has to.

### I6 · A prompt template is a single file

`packages/host/slot-kit/src/prompt.ts` — `readTemplate`

No way to compose one from several, so a Project sharing conventions across
repositories duplicates them.

### I9 · Kernel spawn copies still poll; Persistence Port still N+1

`packages/kernel/*/src/child/run-child.ts`, `packages/kernel/work-ledger/src/ledger/open-work-ledger.ts` (`listDeclaredWorkspaces`)

The four Transformer `run-child` copies share Implementer's 8 MiB flood kill
and end the child's whole tree through `process-tree.ts`. They still poll
`shouldInterrupt` every 20 ms. Changing `IsolationBackend` / `FoldBackend` to
take an `AbortSignal` would change packages that implement those backends
(`packages/plugins/isolation-*`). Not done from `packages/kernel/` alone.

`listDeclaredWorkspaces` still `load`s every Feature after `listSummaries`.
Putting workspace paths on `FeatureSummary` would require both persistence
adapters under `packages/` to write them. Not done from `packages/kernel/` alone.

`openConductor` still passes one `brickDurationMs` (default 30 s) to isolate
and integrate. Splitting the ceilings without a measured overrun would be a
guess. Bail still has no holder id: nothing in kernel names a holder.

### I10 · The operator surface stops at text follow

`packages/host/runtime/src/operator/live.ts`

`mason watch` follows the journal as text and `status` prints a snapshot; that
is enough to prove the seam and no more. Still deferred, each for its own
reason: pause and emergency stop as Host commands (RUNBOOKS describes them;
they mutate the ledger from outside the worker, which nothing does yet);
journal rotation (see I13); a full-screen TUI (taste).

Settled since: a child's raw output is no longer lost. It is not forwarded
through the `ProgressWriter` as this entry once planned — that would put an
agent's megabytes on the journal's synchronous path — but written to its own
file by a sink Host injects (`packages/host/runtime/src/loop/streams.ts`).
Neither `watch` nor `status` reads those files yet: the journal names each one
in a `stream-opened` line, and following one is the reader's to do.

### I11 · Host's operator layer still speaks git

`packages/host/runtime/src/operator/init.ts`, `doctor.ts`, `git-remote.ts`

The loop and the config name no tool: a Submission carries a `description`,
a fold answers a `reference`, the Describer is `authority.describe`. The
operator layer does not hold that line — `init` clones, `doctor` checks a
branch and a remote, `git-remote.ts` reads `.git/config` — because the only
isolation and Authority that exist today are git's, and the operator commands
were written against them. A Project without git would get an `init` and a
`doctor` that ask the wrong questions. The right shape is the one the loop has:
the operator asks the loaded isolation plugin for what it needs (its Shape
already has `check`), and Host's own files name no tool. Not done here: it
moves three commands, and nothing without git exists yet to test it against.
### I12 · `id` is still four shapes; only `key` was made consistent

`packages/kernel/conductor/src/run/open-conductor.ts`

Every journal line about a Task now names its Feature in `key`, which is what a
reader joins on. What a line calls the Task itself was left alone, and it is not
one thing: FeatureBreakdown says `key`, Isolator and Integrator say `id`,
Implementer says `task_id`. The values disagree too — `implement` is given a
bare `s1` for a Subtask but `${key}:assembly` for an assembly, and `integrate` a
bare `s1` for a Subtask fold but `${key}:align` for the alignment. The stated
rule is that a Task's id names the unit of work and not what it serves; four of
the eight call sites break it.

Not fixed here because renaming a field or changing an id's shape is a break for
anything already reading the journal, and the correlation problem — which is
what blocked a reader — is solved by `key` alone. The choice left open: make
every `id` unit-local and let `key` carry all correlation, or make every `id`
globally unique and drop `context`. The half-and-half is the one that does not
work.

### I13 · Transcripts still grow without bound

`packages/host/slot-kit/src/transcript.ts`

Streams and the journal are bounded now. Streams are discarded when a Feature
reaches `done` or `cancelled` — what each file held is written to the film
first, so the shape of the run survives the bytes — and an escalation keeps
everything, which is the one outcome where somebody has to go and look. The
journal no longer writes a line per empty pass: they are held and said as one
line carrying the count, at most once a minute — 56% fewer lines and 42% fewer
bytes when the rule is replayed over a real ledger.

Transcripts are not. One Markdown file per agent turn, kept forever, on a real
install 1.9 MB across 143 files. They are not covered by the same rule because
they are older than it, opt-in per slot, and they are the record the Project
chose to keep rather than noise this system produces — deleting them on a
`done` would be deleting somebody's material on their behalf. The same
ledger-driven hook would do it if that is what a Project wants; nothing reads
`observability` to decide yet.

### I14 · A stream is written by `createWriteStream`, which buffers in memory

`packages/host/runtime/src/loop/streams.ts` — `sinkOf`

The sink must not block a Task, so it does not write synchronously. What it uses
instead keeps unwritten chunks in this process's memory when the disk cannot
keep up, which is the failure the bound in `run-child` exists to prevent for the
in-memory copy. A local disk keeps up with an agent's stream and nothing has
been seen to come near it, but no test drives a slow disk. Not chosen: a bounded
queue that drops on overflow, which is the right shape and is more code than the
evidence justifies yet.

### I15 · Only two of the five `run-child` copies film anything

`packages/kernel/integrator/src/child/run-child.ts`, `packages/kernel/isolator/src/child/run-child.ts`, `packages/plugins/isolation-git/src/child/run-child.ts`

The sink was added to Implementer's and FeatureBreakdown's copies, which spawn
the agents. The other three spawn git — short, and quiet enough that the journal
already says what happened. A git command that hangs or fails strangely is
therefore still as opaque as it was. The same four lines would do it.

### I16 · A `listen` that failed no longer hides, but still does not say why

`packages/host/manager-kit/src/port.ts` — `ListenResult`

Found the hard way: a run polled a repository for half an hour writing
`source-lost` every tick, and the reason — the token belonged to an account that
was not a collaborator — was only recoverable by querying the API by hand.

Half fixed. A `listen` that did not complete is no longer treated as a quiet
line: `mason log` stops hiding it and the journal never folds it into a
heartbeat. So the line is visible, repeated, and impossible to miss.

What it says is still only a word. The manager knows the reason — GitHub's own
`detail` — and `ListenResult` has nowhere to put it: `{ outcome, deliveries }`
and nothing else. Every other failing line in the film carries the child's last
words. Fixing it properly means an optional `detail` on that contract, which is
additive but is a change to what every manager package answers, so it is not
being slipped in here.
