# Host

The composition root, not a Transformer. It is the process you run: Cursor, admission,
Conductor, report. It is not a FeatureStandard transformer and it is not a
sequencer — Conductor sequences; this package calls it.

Host does not know a tracker. It resolves one FeatureManager package, hands it
the options it never reads, and drives the `ManagerPort` that package returns.
Adding GitLab or Jira changes nothing here.

## 1. Job

```
  boot                         Host, each tick                       others
  ----                         ---------------                       ------
  paths + slots                listen: drain the manager since       the manager package
  manager + its options          the Cursor                          WorkLedger
  the plugins (isolation,      probe: abandon what the tracker       Conductor
    persist)                     no longer lists                     Publisher / Refresher slots
  the work line copy           refresh the work line copy
                               one Delivery at a time:
                                 admit / ready / cancel,
                                 reconcile, drive, report,
                                 save Cursor
                               sweep: drive what is in flight
                                 or received, report
                           ←   idle | ran | stopped
```

**In:** WorkLineStable, how to isolate and fold it (`workLine.isolation`),
workspace root, ledger root, a manager specifier and its opaque options,
Planner / Builder / Gate argv.
**Out:** a typed result. The CLI maps that to an exit code.

## 2. Faces

| Face   | Entry                                                                      | Must not                                      |
| ------ | -------------------------------------------------------------------------- | --------------------------------------------- |
| Import | `openHost(options)` then `runOnce` / `run`                                 | Live inside Conductor `src/run/`              |
| CLI    | `mason run \| watch \| status \| log \| cancel \| init \| setup \| doctor` | Interpret a FeatureStandard; pick Child paths |

`src/loop/` is the process: `open-host.ts` opens packages (composition),
`tick.ts` runs the listen / probe / Cursor / sweep loop, `deliveries.ts` handles one
Delivery, `drive.ts` runs one Project and reports on the Feature that ran,
`report.ts` maps Conductor outcomes to FeatureManager Events,
`journal.ts` and `trace.ts` are its film and its stdout. `loop/` may import
Transformer packages: this package **is** the composition root for the
execution Transformers. Conductor still must not. Host must not import a
tracker or an isolation strategy by name: both reach it through `plugins/`.
§ 1–7 describe `loop/`; § 8 describes `operator/`. The layers and the one
import rule between them are in [README.md](./README.md) § Layers.

## 3. Configuration

`mason.config.yaml`, found by walking up from the working directory, or the
file `--config` names. Relative paths in the file resolve against the file;
relative paths in a flag resolve against the working directory. Flags override
the file. `--manager-option key=value` merges per key, so overriding one option
does not drop the others; a repeated key becomes an array.

Host validates only its own keys, against a closed list: an unknown key is a
refusal, not something ignored. `managerOptions` is copied through untouched:
a tracker's fields are that package's business, and its errors are that
package's words.

`observability` is the one key that changes nothing about how work is done, only
what is written down about it. It holds `streams` — `enabled`, `dir`, `keep` —
and `enabled` is declared rather than defaulted, for the same reason an
Authority's is: what a stream holds is the Project's own material in the clear.
See § 8.

## 4. Loading a manager

`manager` is a package name or a path. Resolution imports the bare specifier
first — mason and its managers installed side by side in one project — then
walks up from the config file's directory, which covers a global `mason`
driving a locally installed manager. A module without `createManager` is
refused by name, and a manager that cannot read its options returns a reason,
never a throw.

Secrets never pass through Host. The manager reads them from the environment
it is handed.

## 5. Cursor

Path: `<ledgerRoot>/cursor`. Contents: the last committed Listener Cursor, or
absent. `runOnce` passes it as the manager's `since`. After each Delivery is
handled (including skipped / invalid), the Cursor is that Delivery's name.
`unavailable` / interrupt does **not** advance the Cursor: the Delivery is
retried on the next tick.

A crash may replay one Delivery. Handlers must tolerate a repeat: admit is
idempotent on `key`; a manager may append an Event twice — accepted trade for
not losing an Event.

## 6. One Delivery

`adapt` first. Then:

| Adapter                                     | Host                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid` (new, or the intention changed)   | `recordInvalid`, emit `invalid`                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `invalid` (same fingerprint as recorded)    | leave it; the tracker was told, and telling it is what delivered it again                                                                                                                                                                                                                                                                                                                                                                            |
| `upsert` (new/invalid)                      | `admit`, emit `accepted`, then `runProject` when the Project is free; a Project frozen by an escalation queues the Feature (journal `queued`, one `progress` Event) and the sweep starts it once the Project is free. Post-run Events (`planned` / `done` / `escalated`) are reported on the Feature that was driven, not on the delivered key. `progress` (once per refusal) when the Authority sent the Submission back and a repair is on its way |
| `upsert` (in-flight / terminal)             | leave it; do not restart. In-flight is `planning`, `running`, `escalated`, `integrating`, `submitted`; terminal is `merging`, `done`, `cancelled`. An echo of a Host report (Submitted, a progress comment) is this row: do not admit it                                                                                                                                                                                                             |
| `upsert` (`received`)                       | same drive as a new upsert (no second `accepted`)                                                                                                                                                                                                                                                                                                                                                                                                    |
| `upsert` + `signalsReady` while `escalated` | same as `ready` — a poll snapshot has no `labeled` edge                                                                                                                                                                                                                                                                                                                                                                                              |
| `ready`                                     | `resumeReady`, emit `resumed`, `runProject`, then the same post-run Events                                                                                                                                                                                                                                                                                                                                                                           |
| `cancel`                                    | `conductor.cancel`. `cancelled`, or `reject_late` when the ledger says point of no return; nothing on `done` (the issue closing is the Submission's own doing) or `cancelled`                                                                                                                                                                                                                                                                        |
| `unavailable` / interrupt                   | stop the tick                                                                                                                                                                                                                                                                                                                                                                                                                                        |

`runProject` is always preceded by `reconcile` on that Project. Host never
drives an `escalated` Feature: that state is frozen until a human `ready`.

Every Event Host emits is a write to the tracker, and a tracker that lists by
"last updated" delivers the intention again on the next pass because of that
write. No row above may emit on that echo: `invalid` is keyed by fingerprint,
`accepted` by the ledger not knowing the key (or knowing it `invalid`), the
queued `progress` by `eventId`, the post-run Events by the Feature that was
driven, `resumed` by taking the signal back, `cancelled` by the ledger
refusing a second cancel, an in-flight Feature (including `submitted`) by
leaving the upsert.

On top of that, every Event that states a fact carries an `eventId`, so a
manager that already has it says nothing — after a restart as much as within
a pass. The id names the fact: `<key>:accepted:<fingerprint>` and
`<key>:invalid:<fingerprint>` (an edit is a new fact), `<key>:planned:<planned_at>`,
`<key>:integrated:<subtask>`, `<key>:submitted:<reference>`,
`<key>:refused:<n>`, `<key>:queued:<blocker>`, `<key>:resumed:<round>`,
`<key>:escalated:<round>:<kind>[:<subtask>]`, `<key>:done`,
`<key>:cancelled`, `<key>:reject_late:…`. The round is the ledger's count of
`ready` taken: a Plan refused, resumed and refused again has the same Attempt
count both times, and only the round tells the two escalations apart.
`escalation_reminder` alone would carry none, repetition being its point.

## 7. Loop

`run`: `runOnce` then, if `pollIntervalMs` is set, sleep and repeat until
interrupt.

SIGINT / SIGTERM: set the interrupt flag, `conductor.pause()`, stop after the
current Delivery.

Each pass appends JSON lines to `<ledgerRoot>/events.jsonl` (listen, probed,
Transformer progress, admitted, reported, queued, idle, a heartbeat while
`submitted`). That file is a film, not truth: a crash may drop the last lines;
the ledger is still right. `mason run` still writes a human Trace on stdout.
The journal is how another process attaches.

An offer the work could not get past is journaled `submit-refused`, with the
Feature's `key`, `by` (`publisher` when the work could not be placed,
`authority` when the Authority would not open a Submission) and the refuser's
own `reason`. The same reason becomes the escalation's Trace; the line is so
`mason log --problems` and a watcher see why a run stopped, not only that it
did.

After listen, if the manager declares `probe` and the listen reached the source
(`completed`, `listened` — not `source-lost` / `interrupted` / `invalid-invocation`),
Host asks `probe` of every Feature abandon is still legal for (`received`,
`planning`, `running`, `escalated`, `integrating`, `submitted`). `gone` is the
same abandon as a `cancel` delivery, so a deleted item a poll can never list
still frees the Project; `unavailable` is not abandon. Probe runs before the
work-line refresh and the deliveries, so a cancel in this pass can start the
`received` queue on a copy that was just fast-forwarded.

The sweep after the deliveries drives every Project that has work in flight
**or** `received`, once per tick. The result is reported on the Feature that
was driven. A `received` Feature behind an escalation is journaled `queued`
and left; the next sweep that finds the Project free claims it. The same set
(`in-flight ∪ received`) decides whether this pass refreshes the work line
copy: starting a queued Feature on a copy that was not fast-forwarded this
tick would build on a version that no longer exists.

## 8. init, setup, doctor, watch, status, log and cancel

`init` writes a config that already runs: the Planner is the bootstrap one from
`@bluewombat/slots/planners/`, the Builder is a stub that says what to replace
(example Cursor CLI and Claude Code Builders live in `@bluewombat/slots/builders/`),
and the Gate sequence starts empty. Example Gates live in
`@bluewombat/slots/gates/` (`parent-clean`, `sensitive-path`,
`workspace-changed`, `ci-green`).

Two Gate sequences: `builder.gates` is judged on each Subtask, `assembly.gates`
on the feature they assemble into. A check that is right for one can be wrong for the
other — `workspace-changed` says an Attempt that changed nothing did nothing,
which is true of a Subtask and false of an assembly whose correct outcome is that
nothing was left to do. The assembly produces nothing unless something refused it
first: it is a judgement, and a refusal is `assembly.fix`, not a second first-pass.
Two things may judge it: the Gate sequence (`assembly.gates`, and an Authority's
own checks on what was published) and, optionally, `assembly.validate` — a local,
read-only pass that runs before either. Both send a refusal to the same `fix`
and spend the same `maxRefusals` budget.

Every child of a Task carries its own ceiling and no other. Every `cmd` names
its own `timeoutMs`, and none is inherited from a neighbour — nothing else
bounds a producer. A Gate takes its own `timeoutMs`,
or its sequence's `defaultTimeoutMs`, and a Gate that would end up with neither
is refused when the config loads. Nothing is derived from what another child
left behind, so what bounds a whole Task is arithmetic the Project can do:
the builder's `maxAttempts` times its producer's ceiling plus the sum of its Gates'.
An assembly fix is bounded the same way from `assembly.maxAttempts` and `assembly.fix`.
Root `timeoutMs` bounds what is outside a Task — the manager, the
isolations. Host has no flag named after a tracker (`--repo` is not a Host
flag): tracker fields come from that package.

At a terminal it asks rather than demands. Which manager comes from the packages
installed nearby that declare the `mason-manager` keyword — Host holds no list
of trackers, so a third-party one is offered the same way. A single one is named
and confirmed rather than assumed: picking it silently reads as though the tool
only speaks that tracker. None installed is an error naming the install
command. What that manager needs comes from its own `questionsManager`: it
declares the wording and the validation, Host reads the line. An option already
given on the command line is not asked for again.

WorkLineStable must exist before a run, so `init` inspects the path, names the
branch when it is a git tree, writes `workLine.isolation` to
`@bluewombat/isolation-git` or `@bluewombat/isolation-copy` from that inspection
(Isolator and Integrator do not choose a strategy; Host loads the package named
here), and offers to clone one —
after listing the
remote's branches and refusing a name that is not among them, because a
`git clone --branch` that misses complains about the repository rather than the
name that was wrong. `--clone REMOTE` (with an optional `--branch`, defaulting
to the remote's own HEAD) answers that question ahead of time, so a script
reaches the same place through the same code. An existing directory is never
re-cloned. `init` then runs `setup` and offers to apply it, so nothing has to be
re-run by hand.

A flag is read by the same question that would have asked for it, so
`--manager-option labels=mason` lands in the config in the shape a typed answer
would, and a malformed one is refused before anything is written. The setup plan
that follows never decides `init`'s exit code: it wrote its files, and
`mason init && mason setup --apply` must not stop because a token is not
exported yet.

`--manager` turns every question off, which is what a script wants;
`--interactive` forces them when stdin is a pipe. Overwriting an existing config
needs `--force`, or a yes to the question. Ctrl-C, Ctrl-D, or a pipe running dry
stops on the spot with `Cancelled. Nothing written.` and exit 130 — a read after
the input has ended raises rather than answering empty, so no question is ever
re-asked at a terminal nobody is at. A refused answer is re-asked at most three
times, each time saying what was wrong with it.

`setup` asks the manager to bring the tracker to the shape a run expects. Host
knows none of that shape: it resolves the manager, calls `setupManager`, and
prints the steps. Without `--apply` nothing is written — a plan says what is
`satisfied` and what is `missing`. With `--apply`, a step it fixed is `applied`.
A `blocked` step exits 1; a `missing` step in a plan does not. A manager with no
`setupManager` is reported as having nothing to do, and exits 0.

`doctor` reports one line per check and exits 1 on any `fail`: the Node
version, which config was found, whether the invocation is complete, whether
WorkLineStable exists (and whether it is a git tree), whether `workLine.isolation`
matches that tree and Authority, whether the created
directories have an existing ancestor, whether every slot command resolves,
whether the manager loads, and then the manager's own findings. It parses
without demanding that paths exist, so one missing directory does not hide
every other check, and it never uses the network.

A run names itself. `openHost` mints a `run_id`, stamps it on every journal
line it writes, and opens the film with `host-started` — pid, Host's version,
the manager, the ledger root — and closes it with `host-stopped` before the lock
is released. A journal holds every run that ever wrote to that ledger, and
without these a reader cannot tell one process's film from the next, nor a run
that ended from one whose process was killed: the missing `host-stopped` is how
the second is said. Every line about a Task also carries the Feature it serves,
as `key`; a line that names a Task and no Feature is a line nothing can join.

`observability.streams` films what every child says, as it says it: the
producers, the Gates, the Planner. One file per child under
`<dir>/<feature>/<task>-attempt-<n>[-gate-<id>]-<stamp>.ndjson`, one JSON object
per chunk with its own stamp and which stream it came from, filed under the same
directory name a transcript uses. Each file is named in the journal by a
`stream-opened` line, so nothing has to rebuild the path. `dir` resolves against
the config directory and defaults to `<home>/streams`; `keep` chooses `stdout`,
`stderr`, or both. `--streams-dir DIR` is the same switch for one run, and there
is no bare flag: what a stream holds is the Project's own material in the clear,
and saying where it lands is part of asking for it. Off unless declared.

Writing it is asynchronous and may be lost. The ledger is truth, the journal is
the film and is written synchronously so it lands before the next phase, and
this is the noise underneath — an agent's stream is large enough that putting it
on a synchronous path would make visibility able to take a run down. A child
killed for writing past its output bound is filmed up to the kill: the bound
protects Host's memory, and that child is the one worth having a film of.

A film says what it held as it closes — `stream-closed` with the bytes, the
chunks and the milliseconds — and a Feature that reaches `done` or `cancelled`
has its films removed, which the journal records as `streams-discarded` with the
count and the size. An escalation keeps everything: that is the outcome where
somebody has to go and look. Nothing prunes transcripts.

A pass that listened to nothing and drove nothing is not written as it happens.
Such passes are held and said as a single `idle` line carrying `passes`, at most
once a minute, so a `watch` still shows the loop turning without a line every
poll. A `listen` that did not complete is never held and never hidden.

`watch` and `status` are the operator live view. They open the ledger the same
way `run` does (`openFilesystemPersist` then `openWorkLedger`) and they do not
open a manager, Conductor, or Host. `status` prints a snapshot of every known
Feature and exits. `watch` prints that snapshot, then follows new journal lines
until SIGINT (exit 0). A missing journal is not an error: the snapshot still
stands. `--json` prints the snapshot as JSON. Ctrl-C on watch leaves the worker
running. The file can grow without rotation. A followed line that records a
stop includes the child's last words (`detail`, `reason`, a non-zero exit, a
Gate report that did not pass). `run` prints that same note under the phase
label.

`log` reads that same journal and exits. It does not follow, and it does not
open a manager or Host. Quiet lines (`idle`, a listen that delivered nothing)
are hidden. `--all` keeps them. `--problems` keeps only lines that explain a
stop. `--tail N` keeps the last N of the text film (0 means no limit). `--json`
prints every kept line, and when `--tail` is also passed and drops lines the
object names `kept` and `shown`. After the text film it tallies the distinct
problems. A `result` is counted with the exit code of the `planner-finished`
just before it. A run that then pauses, with no exit code, is tallied as
`interrupted`, apart from a non-zero exit that left the same detail. When a
slot was given `--transcript-dir` it names the newest transcript files with
the agent exit and duration read from the start of each file. A missing
journal is not an error. Exit 2 when the config or `--tail` cannot be read.

`cancel <key>` abandons one Feature the same way a `cancel` delivery does. The
team still abandons in the FeatureManager; this is the hatch when the tracker
cannot say the intention is gone (a manager with no `probe`, or an operator
who already knows) and the ledger would otherwise freeze the Project. It
takes the ledger lock — stop `run` first if it holds it. Exit 0 on cancel or
already cancelled, 1 when abandon is refused (`done`, point of no return), 2
when the key is missing or the ledger does not know it. The key is the first
positional: `cancel github:owner/name#19`.

## 9. Acceptance

1. Convertible upsert in an empty Source → WorkLineStable carries the Builder
   marker, Thread `accepted`, `planned`, `done`, Cursor is that file name.
2. Unconvertible upsert → Thread `invalid`, no Conductor work, Cursor advanced.
3. Fail-blocking Gate, then a `ready` Event, then passing Gates → Thread
   contains `escalated` then `resumed` then `done`.
4. `cancel` while `escalated` → Thread `cancelled`; WorkLineStable seed-only.
5. Re-running `runOnce` with the saved Cursor does not re-deliver the first Event.
6. GitHub: convertible issue (mocked API) → WorkLineStable marker, comments
   `accepted`, `planned`, `done`.
7. GitHub: fail-blocking then the same issue with the ready label → `escalated`,
   `resumed`, `done`.
8. A manager named by path, and one named by package, both load; a module without
   `createManager` is refused by name.
9. `init --manager` then `doctor` in an empty directory reports exactly what is missing;
   `init` without `--manager` and without a terminal is refused.
10. `setup` without `--apply` writes nothing, and names the flag that would;
    a manager without `setupManager` exits 0 saying so.
11. The wizard names the only installed manager, repeats a question its manager
    refused, and skips an option already passed as a flag.
12. `--clone` takes the named branch, falls back to the remote's default,
    refuses a branch the remote does not carry, and re-clones nothing.
13. `list()` after admit of two keys returns two summaries; a refused command
    does not appear; `listInFlight()` is the mid-flight subset.
14. A Transformer `status` line and a `gate-finished` line during `runProject`
    appear in `<ledgerRoot>/events.jsonl`.
15. `watch` on a ledger with Features and no journal prints the snapshot,
    including a `submitted` Feature's reference, and exits 0 on interrupt. It
    does not import `openHost` or a manager package.
16. Two Features on one Project, the first `escalated`: admitting the second
    emits `accepted` and one `progress` (queued), not `escalated`; the second
    stays `received`. Cancelling the first in a later pass starts the second.
    A `submitted` Feature that reaches `done` while a second is delivered
    reports `done` on the first.
17. After an escalation, a `probe` of `gone` cancels that Feature and the sweep
    starts the `received` queue in the same pass. `unavailable` leaves the
    escalation. A listen that missed the source does not probe. GitHub: a 404
    on `GET /issues/{n}` after a completed listen cancels, even when the
    listing is empty. `cancel <key>` abandons an escalated Feature.
18. A Feature `submitted`, then the same upsert delivered again, then the
    Authority refuses: Host skips the echo, records no `pending_fingerprint`,
    and the next pass repairs. It does not escalate as a plan refusal.
19. `log` on a journal that recorded `unavailable` with a `detail` prints that
    detail, hides `idle`, and `--problems` drops the phase labels that are not
    themselves the failure. `--json` returns every kept line. A paused run
    with no planner exit code is tallied apart from a non-zero exit. It does
    not import `openHost`.

How to install, configure and run: [README.md](./README.md).
