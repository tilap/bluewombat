# Host

The composition root, not a Transformer. It is the process you run: Cursor, admission,
Conductor, report. It is not a TicketStandard transformer and it is not a
sequencer — Conductor sequences; this package calls it.

Host does not know a tracker. It resolves one TicketTracker package, hands it
the options it never reads, and drives the `Manager` (a FeatureTracker and a TicketTracker) that package returns.
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
                                 admit / resume / cancel,
                                 reconcile, drive, report,
                                 save Cursor
                               sweep: drive what is in flight
                                 or received, report
                           ←   idle | ran | stopped
```

**In:** WorkLineStable, how to isolate and fold it (`workLine.isolation`),
workspace root, ledger root, a manager specifier and its opaque options,
Builder / Gate argv.
**Out:** a typed result. The CLI maps that to an exit code.

## 2. Faces

| Face   | Entry                                                                                 | Must not                                      |
| ------ | ------------------------------------------------------------------------------------- | --------------------------------------------- |
| Import | `openHost(options)` then `runOnce` / `run`                                            | Live inside Conductor `src/run/`              |
| CLI    | `mason run \| watch \| status \| log \| cancel \| release \| init \| setup \| doctor` | Interpret a TicketStandard; pick Child paths |

`src/loop/` is the process: `open-host.ts` opens packages (composition),
`tick.ts` runs the listen / probe / Cursor / sweep loop, `deliveries.ts` handles one
Delivery, `drive.ts` runs one Project and reports on the Ticket that ran,
`report.ts` maps Conductor outcomes to TicketTracker Events,
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
the file. `--feature-tracker-option key=value` (and `--ticket-tracker-option`) merges per key, so overriding one option
does not drop the others; a repeated key becomes an array.

Host validates only its own keys, against a closed list: an unknown key is a
refusal, not something ignored. Each side's `options` is copied through untouched:
a tracker's fields are that package's business, and its errors are that
package's words.

`observability` is the one key that changes nothing about how work is done, only
what is written down about it. It holds `streams` — `enabled`, `dir`, `keep` —
and `enabled` is declared rather than defaulted, for the same reason an
Authority's is: what a stream holds is the Project's own material in the clear.
See § 8.

## 4. Loading a manager

`featureTracker.package` and `ticketTracker.package` are each a package name or a path. The two sides may name the same package or two different ones: a package asked for a side it does not answer is refused by name. One package with the same options on both sides is built once. `doctor` and `setup` run each distinct manager once; the reference work line is named by the ticket tracker, which holds the Authority. Resolution imports the bare specifier
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

The FeatureTracker's `listen` delivers Features whose specification is final.
`adapt` first. Then:

| Adapter                                     | Host                                                                                                                                                                                                                |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid` (new, or the intention changed)   | emit `invalid` on the Feature, keyed by fingerprint                                                                                                                                                                 |
| `invalid` (same fingerprint as recorded)    | leave it; the tracker was told, and telling it is what delivered it again                                                                                                                                           |
| `upsert` (absent or `waiting`)              | `admitFeature`, emit `accepted`. Nothing is driven here: the sweep does it                                                                                                                                          |
| `upsert` (`open` or `escalated`) whose `skip_feature_test` differs from the ledger's | `setFeatureSkipFeatureTest`; journal `skip-feature-test`; no other change |
| `upsert` (any other state)                  | leave it; journal `skipped`. An echo of a Host report is this row                                                                                                                                                   |
| `upsert` + `signalsResume` while `escalated` | same as `resume` — a poll snapshot has no `labeled` edge                                                                                                                                                             |
| `resume`                                     | resume the Feature, emit `resumed`                                                                                                                                                                                  |
| `cancel`                                    | `cancelFeatureFlow`: the Tickets not done are cancelled, the line is dropped, the Project is free                                                                                                                    |
| `unavailable` / interrupt                   | stop the tick                                                                                                                                                                                                       |

A Ticket is never delivered: the sweep reads the Tickets of the open Feature
from the TicketTracker (`tickets`). A `resume` on an escalated Ticket, an edit of
a Ticket not yet started, a Ticket closed on the tracker are read there
(`syncTickets`) and acted on the same way as for a Feature. A Ticket in flight is
not admitted again on each pass; only a `received` Ticket whose fingerprint
changed is.

### The sweep: one Feature per Project

Every pass, each Project with a `waiting`, `open` or `submitted` Feature is
advanced (`advanceProject`):

1. No active Feature: open the next one that may. A Feature may open when every
   Feature blocking it is `done`, and every one of its Tickets
   (`tickets`) is `task_ready`. Order: priority, then age. The Feature is then
   `open`: with an Authority, its line `feature/<id>` is cut from the final
   branch (`openLine`); the Tickets are admitted with their Feature and their
   blockers.
2. `open`: the work line copy is refreshed onto the line, then Tickets are
   driven one at a time (a Ticket whose blockers are not `done` is skipped; the
   next by priority then age is taken). Each Ticket's Submission targets the line. When every Ticket
   is `done` or `cancelled` the Feature is closed: the line goes to the
   Authority (`submit`). With no Authority the Feature is `done` at once.
3. `submitted`: the Feature waits. Without `merge-when-ready` a human folds it;
   `settled` says `folded` (done) or `closed` (escalated). With
   `merge-when-ready` the assembly judgement runs on the line and the Authority
   folds it. No other Feature opens on the Project meanwhile.
4. A Feature whose Tickets are all blocked escalates; one that cannot be
   settled because the Authority lacks `settled` waits.

The Feature's own work (`.mason/feature-workspaces/<feature>`) is cut from its
line once, when it is closed, and a pass that sent it to the fix finds it where
it was left. A resume is the one time the line may have gained commits since
(a person's): `resumeFeature` marks the work stale (`workspace_stale`), and the
next pass, before judging, refreshes the line and runs the Integration with the
work as Parent and the line copy as Child (`<key>:resume`), so what the work
holds, a refused fix's commits included, stays. Once it is done the mark is
cleared (`markFeatureWorkspaceCurrent`); a refresh that fails or an interrupt
leaves it, and the next pass tries again. A conflict is not settled by Host: the
Feature escalates (`assembly`) with a reason naming the conflict, the work left
as it was, and the mark stays for the next resume. A work cut after the resume
is current by construction.

The feature-test acceptance check, when the Project declares it (`builder.featureTest`):

- A Feature does not open (and is reported `invalid`, once per reason) unless it holds exactly
  one feature-test Ticket (`TicketEntry.featureTest`), blocked by every other live Ticket, or carries `skip_feature_test`.
- A Ticket with `feature-test` is admitted with `feature-test`, and
  Transformers makes it with `builder.featureTest` (its command, its Gates, for the first pass, a refused
  pass and the recheck) instead of the producer and the repair.
- A Feature with `skip_feature_test` has its feature-test Ticket cancelled by the sweep (journal
  `feature-test-ticket-cancelled`, a trace line), and Transformers leaves out, for that Feature, every
  Gate of `feature.validate`, `feature.gates` and `feature.fix` that has `skipWhen:
  skip-feature-test`: the journal gets `gate-skipped` with the Gate id and the reason, and the trace
  says "`<id>` not run: the Feature carries skip-feature-test". The mark is read from the ledger as
  each pass starts (`TransformerSlots.marks`).
- A Feature that is not marked and no longer holds a live feature-test Ticket (it was cancelled while the
  mark was on) escalates when it closes.

Host never drives an `escalated` unit: that state is frozen until a human `resume`.

Every Event Host emits is a write to the tracker, and a tracker that lists by
"last updated" delivers the intention again on the next pass because of that
write. No row above may emit on that echo: `invalid` is keyed by fingerprint,
`accepted` by the ledger not knowing the key (or knowing it `invalid`), the
post-run Events by the Ticket that was driven, `resumed` by taking the signal back, `cancelled` by the ledger
refusing a second cancel, an in-flight Ticket (including `submitted`) by
leaving the upsert.

On top of that, every Event that states a fact carries an `eventId`, so a
manager that already has it says nothing — after a restart as much as within
a pass. The id names the fact: `<key>:accepted:<fingerprint>` and
`<key>:invalid:<fingerprint>` (an edit is a new fact), `<key>:submitted:<reference>`,
`<key>:refused:<n>`, `<key>:resumed:<round>`,
`<key>:escalated:<round>:<kind>`, `<key>:done`,
`<key>:cancelled`, `<key>:reject_late:…`. The round is the ledger's count of
`resume` taken: an escalation resumed and escalated again has the same Attempt
count both times, and only the round tells the two escalations apart.
`escalation_reminder` alone would carry none, repetition being its point.

## 7. Loop

`run`: `runOnce` then, if `pollIntervalMs` is set, sleep and repeat until
interrupt.

SIGINT / SIGTERM: set the interrupt flag, `conductor.pause()`, stop after the
current Delivery. The same flag is handed to every Transformer Host runs, so a
child at work — a producer, an assembly fix — is killed with its tree rather
than waited for; the Transformer then answers `interrupted`. `mason run` exits
130 on an interrupt, wherever it landed; else 1 when the last run was refused,
0 otherwise.

Each pass appends JSON lines to `<ledgerRoot>/events.jsonl` (listen, probed,
Transformer progress, admitted, reported, queued, idle, a heartbeat while
`submitted`, one `held` while a unit waits on a bail that has not expired).
Every report to the tracker is filmed with how long it took (`ms`): `reported`
when the manager took it (including a Thread that already carried that eventId
— a duplicate is already said), `report-declined` when it failed. That file is
a film, not truth: a crash may drop the last lines;
the ledger is still right. `mason run` still writes a human Trace on stdout.
The journal is how another process attaches.

An offer the work could not get past is journaled `submit-refused`, with the
Ticket's `key`, `by` (`publisher` when the work could not be placed,
`authority` when the Authority would not open a Submission) and the refuser's
own `reason`. The same reason becomes the escalation's Trace; the line is so
`mason log --problems` and a watcher see why a run stopped, not only that it
did.

After listen, if the manager declares `probe` and the listen reached the source
(`completed`, `listened` — not `source-lost` / `interrupted` / `invalid-invocation`),
Host asks the FeatureTracker's `probe` of every Feature, and the
TicketTracker's of every Ticket, abandon is still legal for. `gone` is the
same abandon as a `cancel` delivery, so a deleted item a poll can never list
still frees the Project; `unavailable` is not abandon. Probe runs before the
work-line refresh and the deliveries, so a cancel in this pass can start the
`received` queue on a copy that was just fast-forwarded.

The sweep after the deliveries advances every Project that has a `waiting`,
`open` or `submitted` Feature, once per tick (§ 6). The result is reported on
the Ticket that was driven. The work line copy is refreshed onto the Feature's
line before a Ticket starts: starting on a copy that was not fast-forwarded
would build on a version that no longer exists.

## 8. init, setup, doctor, watch, status, log, incident, cancel and release

`init` writes a config that already runs: the Builder is a stub that says what to replace
(example Cursor CLI and Claude Code Builders live in `@bluewombat/slots/builders/`),
and the Gate sequence starts empty. Example Gates live in
`@bluewombat/slots/gates/` (`parent-clean`, `sensitive-path`,
`workspace-changed`, `ci-green`).

Four Gate sequences: `builder.gates`, shared by `builder.producer` and
`builder.repair`, then `ticket.fix.gates`, `ticket.validate.gates` and
`ticket.gates` for the one judgement-only pass with no producer of its own.
The assembly sequences are not shared and nothing is dispatched between buckets: a check that is right for one pass can be wrong
for another, even within the same stage — `workspace-changed` says an Attempt
that changed nothing did nothing, which is true of `builder.producer`/`repair`
and false of `ticket.gates`'s pass, whose correct outcome is that nothing
was left to do. A repair Attempt is judged by `builder.gates`, the same list as the
producer's (Host hands Implementer that list as both `gates` and `repairGates`). The assembly's
judgement-only pass produces nothing unless something refused it first: it is
a judgement, and a refusal is `ticket.fix`, not a second first-pass. Two
things may judge it: `ticket.gates` (and an Authority's own checks on what
was published) and, optionally, `ticket.validate` — a local, read-only pass
that runs before either, judged by its own `ticket.validate.gates`, not
`ticket.gates`. Both send a refusal to the same `fix` and spend the same
`ticket.maxRefusals` budget.

Every child of a Task carries its own ceiling and no other. Every `cmd` names
its own `timeoutMs`, and none is inherited from a neighbour — nothing else
bounds a producer. A Gate takes its own `timeoutMs`,
or its sequence's `defaultTimeoutMs`, and a Gate that would end up with neither
is refused when the config loads. Nothing is derived from what another child
left behind, so what bounds a whole Task is arithmetic the Project can do:
the builder's `maxAttempts` times its producer's ceiling plus the sum of its Gates'.
An assembly fix is bounded the same way from `ticket.maxAttempts` and `ticket.fix`.
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
`--manager-option repo=owner/name` lands in the config in the shape a typed answer
would, and a malformed one is refused before anything is written. The setup plan
that follows never decides `init`'s exit code: it wrote its files, and
`mason init && mason setup --apply` must not stop because a token is not
exported yet.

`--manager` (one package for both sides; the config is where they are told apart) turns every question off, which is what a script wants;
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
the second is said. Every line about a Task also carries the Ticket it serves,
as `key`; a line that names a Task and no Ticket is a line nothing can join.

`observability.streams` films what every child says, as it says it: the
producers and the Gates. One file per child under
`<dir>/<ticket>/<task>-attempt-<n>[-gate-<id>]-<stamp>.ndjson`, one JSON object
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
chunks and the milliseconds — and a Ticket that reaches `done` or `cancelled`
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
Feature and Ticket and exits: a header with the counts, then one line per Feature
(key, state, title, the Submission or why it stopped) with its Tickets indented
under it, then the Tickets that belong to no Feature under `No Feature`. A Ticket
holding the feature tests is marked `[feature-test]`. Features that need a person
(`escalated`) come first, then those in progress, then `done` and `cancelled`.
Keys are ordered by tracker, then by number (`#18` before `#107`), the order
`incident` lists what waits for a person in too. Plain text, no colour. `watch` prints that snapshot, then follows new journal lines
until SIGINT (exit 0). A missing journal is not an error: the snapshot still
stands. `--json` prints the same tree: `{ features: [{ …, tickets: […] }], tickets: […] }`,
the latter holding the Tickets of no Feature. Ctrl-C on watch leaves the worker
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
problems, each stop once with how many times it happened. When a
slot was given `--transcript-dir` it names the newest transcript files with
the agent exit and duration read from the start of each file. A missing
journal is not an error. Exit 2 when the config or `--tail` cannot be read.

`incident [<key>]` gathers what is known about one stop into a single page, for a
person (or anything else) who has to understand it. Read-only: it opens the
ledger, the journal, the streams and the transcripts, and writes only where
`--out DIR` says (`incident.md` and `incident.json`). It does not open Host, a
manager or Conductor, so it works on a stopped run and on one still going. The
key is a full key or the tracker's number (`106`, `#106`) when one key ends so;
two matches name both and exit 2, no match exits 2. With no key it lists what
waits for a person: every escalated Feature and Ticket, one line each. `--json`
prints the page as JSON.

The page is the schema `bluewombat.incident/1`. It states, without judging:
the subject (kind, state, the first lines of what was asked, `blocked_by`); the
stop (layer, what the ledger says verbatim, who refused it, the Gate or agent
that ended the last round with its verdict, the Task and Attempt, the moment);
the stops of this subject in the journal and its resumes; the budgets spent;
the Tickets of the Feature, each with state, Attempts, pull request and the
moment it landed; the configuration of the refusing Gate; the system (bluewombat,
Node, the `@bluewombat/*` packages the Project installed, and what the
configuration switched on: trackers, ledger, Authority, tickets in parallel,
limits, which passes run an agent or only Gates, each Gate sequence, streams;
a command shows its program only, never its arguments, which may hold a key); the journal's events
of the last round; the stream files and the transcripts under the subject, with
the end of the refusing Gate's stream, each agent's exit, duration, closing
words and `MASON_VERDICT` / `MASON_BLOCKED` line; and `gaps`, what could not be
found. A reader must never read an absence as a "no": a missing journal, a
stream that was never filmed or is gone, a Gate no longer in the configuration
and a subject that is not stopped are each said in `gaps`. The last round is
what the journal holds between the previous stop of the subject (or its
beginning) and the last `status` of phase `escalated`; without that line the
page says so and takes the moment from the ledger. `--with-config` adds the
configuration file itself, with the value of any `key: value` line whose key
looks like a secret (token, secret, password, api key, credential) blanked. The
page quotes the ledger's
words with a fence longer than any backtick run in them.

An escalation records, beside its words, who refused it (`refused_by`: a Gate's
id or a role, when the refusal came with a name) and when (`at`, the ledger's
clock); a Feature's also records where its line stopped (`kind`: `assembly` for
the assembled line refused by a check, `submitted` for its offer). All are
optional: a record written before them stays readable, and the page then takes
the refuser from the last non-passing Gate whose words the ledger repeats. The
tracker is told the stage of a Feature's stop from that `kind` (`integrating`
for an assembled line, `submitting` otherwise).

`restart <feature-key>` resumes an escalated Feature with a fresh workspace: the
Feature's work is removed (the same `rm` as a cancel) and the ledger's `resumeFeature` is taken,
so the next pass cuts the work again from the line and judges it. Nothing is said to the tracker and
nothing is fetched. It takes the ledger lock — stop `run` first. The key is the full key or the
tracker number, as `incident` takes it. Exit 0 once restarted, 1 when the Feature is not
`escalated`, 2 for a missing, unknown or Ticket key. The journal gets `restarted`.

`cancel <key>` abandons one Ticket the same way a `cancel` delivery does. The
team still abandons in the TicketTracker; this is the hatch when the tracker
cannot say the intention is gone (a manager with no `probe`, or an operator
who already knows) and the ledger would otherwise freeze the Project. It
takes the ledger lock — stop `run` first if it holds it. Exit 0 on cancel or
already cancelled, 1 when abandon is refused (`done`, point of no return), 2
when the key is missing or the ledger does not know it. The key is the first
positional: `cancel github:owner/name#19`.

`release <key>` drops a held unit without waiting for the bail clock — the
hatch after a crash left nobody on the work. A clean stop releases itself. It
takes the ledger lock — stop `run` first if it holds it. Exit 0 when the unit
was released or the Ticket was already free, 1 when the Ticket is not
`running` (the state is named),
2 when the key is missing or the ledger does not know it. The key is the first
positional: `release github:owner/name#19`.

## 9. Acceptance

1. Convertible upsert in an empty Source → WorkLineStable carries the Builder
   marker, Thread `accepted`, `done`, Cursor is that file name.
2. Unconvertible upsert → Thread `invalid`, no Conductor work, Cursor advanced.
3. Fail-blocking Gate, then a `resume` Event, then passing Gates → Thread
   contains `escalated` then `resumed` then `done`.
4. `cancel` while `escalated` → Thread `cancelled`; WorkLineStable seed-only.
5. Re-running `runOnce` with the saved Cursor does not re-deliver the first Event.
6. GitHub: convertible issue (mocked API) → WorkLineStable marker, comments
   `accepted`, `done`.
7. GitHub: fail-blocking then the same issue with the resume label → `escalated`,
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
15. `watch` on a ledger with Tickets and no journal prints the snapshot,
    including a `submitted` Ticket's reference, and exits 0 on interrupt. It
    does not import `openHost` or a manager package.
16. Two Features on one Project: the second does not open while the first is
    open, escalated or submitted. A Feature blocked by another does not open
    until it is `done`. A Feature whose Tickets are not all `task-ready` does
    not open.
16b. With the feature-test check declared: a Feature without a feature-test Ticket nor `skip_feature_test` does not open and
    is reported `invalid`; with `skip_feature_test` its feature-test Ticket is cancelled and the feature-tests Gate is not run,
    the journal and the trace saying so; with a feature-test Ticket the line is judged once by the suite,
    red goes to `feature.fix` and green lets the line be offered. A Project without `builder.featureTest`
    is unchanged.
17. After an escalation, a `probe` of `gone` cancels that Ticket (or Feature)
    and the sweep goes on. `unavailable` leaves the
    escalation. A listen that missed the source does not probe. GitHub: a 404
    on `GET /issues/{n}` after a completed listen cancels, even when the
    listing is empty. `cancel <key>` abandons an escalated Ticket.
18. A Ticket `submitted`, then the same upsert delivered again, then the
    Authority refuses: Host skips the echo, records no `pending_fingerprint`,
    and the next pass repairs. It does not escalate as an edited intention.
19. `log` on a journal that recorded `unavailable` with a `detail` prints that
    detail, hides `idle`, and `--problems` drops the phase labels that are not
    themselves the failure. `--json` returns every kept line. It does
    not import `openHost`.

20. `incident` on a Feature escalated by a Gate names that Gate, quotes the ledger
    verbatim, lists the Feature's Tickets with their pull requests and says in
    `gaps` what it could not read. On a Ticket that stopped on a Gate it names
    the Gate and the Feature above it. With no key it lists what waits. It
    opens no Host and writes nothing but `--out`.
21. A Feature's line refused by a check that cannot be repaired escalates with
    `refused_by` set to that check and `kind` `assembly`, and the tracker is told
    `integrating`.

How to install, configure and run: [README.md](./README.md).
