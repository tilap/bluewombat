---
title: Product and domain
summary: What bluewombat does, who uses it, the domain rules, and the vocabulary the code must follow.
covers: []
---

# Product and domain

> Scope: what the code cannot tell you. Roles, rules, and vocabulary.
> Detailed feature specifications live in the tracker — link them, do not copy them here.

## What it does

bluewombat is an autonomous project-execution system. A human states a need as a
**Feature** in an external FeatureTracker, and the work to do for it as
**Tickets** in an external TicketTracker. When the Feature is ready, the system
takes its Tickets one at a time, each in an isolated workspace, validates each
through a Project-defined sequence of Gates, and lands it on the Feature's own
line (a branch). When every Ticket has landed, the Feature's line is submitted
to the Authority, which folds it into the Project's final line, with a human or
without one.

On the happy path there is no human in the loop. The human writes and validates
the Feature and its Tickets, answers escalations, and merges the Feature's line
unless the Feature says it may merge by itself. They read, correct, abandon, and
signal `resume` only in the FeatureTracker and the TicketTracker, with a Trace
when work has already been attempted.

The operator meets the system as one command-line tool, **mason**: `mason init`
sets a Project up, `mason run` is the process that listens, builds, validates
and folds, `mason watch`, `status`, `doctor`, `setup`, `cancel` are its levers.
bluewombat is the whole — the packages, the rules, the words; mason is the name
on the binary, the config file, the home directory, and the labels it writes on
a tracker.

The repository is three groups of packages — kernel, host, plugins — on one
TypeScript toolchain. This document is the product: the workflow, its rules,
and its words, with no stack in it. A package's binary and CLI are documented
next to that package. The stack is [DEVELOPMENT.md](./DEVELOPMENT.md).

## Who uses it

| Role                     | Needs                                                                | Can do                                                                           | Cannot do                                                                 |
| ------------------------ | -------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Human (project team)     | A delivered Feature, or a clear block with a Trace                   | Write Features and Tickets, signal them ready, edit and abandon them, answer escalations, merge a Feature's line | Drive the happy path; open the WorkLedger to know where a Ticket stands   |
| FeatureTracker           | To remain the human surface for Features                             | Host raw Features and receive emitter events                                      | Execute work or hold system truth                                         |
| TicketTracker            | To remain the human surface for Tickets                              | Host raw Tickets, their order, and receive emitter events                         | Execute work or hold system truth                                         |
| bluewombat (this system) | A TicketStandard it can run                                          | Listen, normalize, execute, validate, integrate, escalate, report                 | Invent business content; revert a Ticket already in a Feature's line      |
| Builder                  | A Ticket intention and an isolated workspace                         | Produce the unit of work                                                          | Integrate; talk to a tracker; decide Gate verdicts                        |

## Domain rules

Business invariants that must hold regardless of implementation. Each one should be
falsifiable — if code violates it, that is a bug, not a design choice.

- A Feature belongs to exactly one Project. A Ticket belongs to exactly one Feature.
- A Project has at most one open Feature at a time, and in it at most
  `ticket.maxParallel` active Tickets (default 1: one after the other). Above 1, the
  Tickets land one by one through the Authority. Distinct Projects may run in parallel.
- A Feature opens only when it is **feature-ready**, every Feature that blocks it is
  `done`, and every one of its Tickets is **task-ready**. A Feature whose Tickets are
  not all task-ready does not open, whatever the others say. Among the Features
  that may open, the one with the highest priority goes first, then the oldest.
- A Ticket starts only when every Ticket that blocks it is `done`. Among the
  Tickets that may start, the highest priority goes first, then the oldest.
  Tickets of an open Feature run one at a time.
- One open Feature has one **line**: a branch cut from the Project's final line
  when the Feature opens. Each Ticket lands on that line, never on the final
  line.
- When every Ticket of the open Feature is `done`, its line is submitted to the
  Authority for the final line. With **merge-when-ready** on the Feature, the
  system folds it once the checks accept; without it, a human merges, and the
  system starts no other Feature until that merge is done.
- Nothing enters a Feature's line unless the Ticket passed the Project's Gate
  sequence for a Ticket, **and** the assembled Ticket was judged — by its own Gate
  sequence, by the Authority, or by both. The two sequences are separate: a check
  that is right while the work is made can be wrong once it is assembled.
- A Ticket is folded into its line only if the line has not moved on since the
  Ticket was aligned with it and judged. If it has, the Ticket goes back to be
  aligned and judged again; that is not a refusal and asks nothing of a fixer.
  The line moves on when a person writes to it, and would when Tickets run side by
  side. The same goes for a fold the Authority refuses.
- Whatever goes wrong after the work was made is corrected, not stopped on: a
  conflict while aligning, a check that fails once the line's code is in, a
  refusal of the review or of the Authority. Each sends the Ticket to the fix with
  the reason, and the Ticket starts again from the alignment. All of these draw on
  one budget, `maxRefusals`; when it is spent, or when nothing can fix the cause,
  the Ticket escalates.
- A Feature may be proved by its **e2e acceptance suite**: a few scenarios (five at most,
  ids `E1`, `E2`…) agreed with the operator before development and written, verbatim, in the
  body of its last Ticket, the **e2e Ticket**. That Ticket is blocked by every other Ticket, is
  made by its own pass, writes only the suite folder and a manifest of the scenario ids, and
  never runs the suite. The suite is run **once**, on the assembled Feature line, by a Gate of
  the Feature's checks; it never runs per Ticket. A suite that is red refuses the line and sends
  it to the Feature's fix, which repairs the application with the e2e tests frozen. A Project
  that declares the check refuses (`invalid`) a Feature that holds neither an e2e Ticket nor the
  **skip-test-e2e** signal; a Feature that carries the signal has its e2e Ticket cancelled and the
  Gate not run, and the journal and the trace say so. A Project that does not declare the check
  is unchanged.
- After a Ticket is aligned with its line, the Ticket's own checks (the Builder's
  Gates) run again on the result, before anyone reviews it.
- Durable state is written to the WorkLedger before it is acted on. Isolated workspaces
  are a consequence of that state, never the source of it.
- A Gate has three verdicts only: `pass`, `fail-retryable`, `fail-blocking`. The first
  non-pass stops the sequence. A retryable failure starts a new Attempt from the
  **first** Gate, not from the one that failed.
- A Ticket is valid only when every Gate passes in the **same** Attempt.
- `fail-blocking` escalates immediately and does not consume remaining Attempts.
- Escalation freezes the Ticket, hence its Feature and its Project. Resume after
  `resume` starts the Ticket from zero; no opaque half-result is reused.
- When the Project has an Authority, an assembled Ticket enters `submitted`.
  It enters `merging` only once the assembly Gate sequence has passed on it. A
  refusal carries a report and feeds the next Attempt, exactly as any other Gate
  refusal does; it is not a second failure path. `submitted` survives a restart;
  the Ticket is still in flight. A Feature's line follows the same path, without
  a Builder.
- An accepted Submission moves its line. The system's copy is brought up to the
  Authority's state before the next Isolation, so later work starts from the new version.
- Entering `merging` is a point of no return: abandon and intention edits are refused.
  The only allowed human action is `resume`, which returns the Ticket to `integrating`.
- A landed Ticket is never undone. A later Ticket that proves earlier work wrong
  escalates.
- Bound breaches (Attempts, duration, budget) escalate. They never fail silently.
- Admission is idempotent on the external identity (manager + origin id). A duplicate
  event does not restart work that already exists.
- A Transformer does not depend on another Transformer, and a Transformer does not import a
  kernel sibling or a plugin. Wiring several Transformers together happens in Host
  (execution) or in a manager package (one tracker).

## Signals

Three words a human uses to say where a Feature or a Ticket stands. How each is
written is the tracker's own (a label, a status, a field); the meaning is fixed.

| Signal             | On      | Means                                                                                             |
| ------------------ | ------- | ------------------------------------------------------------------------------------------------- |
| `feature-ready`      | Feature | The Feature's content is final. Its Tickets may be written                                         |
| `task-ready`        | Ticket  | The Ticket's specification is final. Set on all of a Feature's Tickets together, once the list is validated, so a half-written Feature never opens |
| `merge-when-ready` | Feature | The Feature's line may be folded into the final line without a human                               |
| `skip-test-e2e`    | Feature | The Feature is not put through the e2e acceptance check: its e2e Ticket is cancelled and the Gate that runs the suite is not run. It can be put on or taken off until the Feature is submitted |
| `e2e`              | Ticket  | The Ticket holds the e2e acceptance suite of its Feature: it is made by `builder.e2e`, with no tests written first |

## Bounds, leases, and stopping

Every bound is the Project's, and a breach escalates — never a silent failure:

- Attempts per Ticket;
- duration of an Attempt, of a Ticket;
- a resource budget per Ticket, opaque at this level.

Every Ticket in flight holds a **lease** (a duration, renewed while work goes
on). An expired lease makes the Ticket recoverable: it returns to `received`, its
isolated directory is destroyed, and the next pass starts from zero and consumes
an Attempt. At startup the system **reconciles** isolated directories against the
WorkLedger and destroys every orphan; the WorkLedger decides, never the disk.

Two ways to stop. A **pause** admits nothing new and starts no Ticket; the
current one runs to its end and nothing is folded. An **emergency stop**
interrupts the Implementer; the Ticket in flight returns to `received` and its
directory is destroyed.

## The human surface

A human acts in three cases only — escalation, abandon (including a deletion on
a tracker), and a corrected intention — and always through a tracker, plus the
merge of a Feature's line when the Feature does not merge itself. A poll cannot
see a deletion: the item is missing from every later page. The tracker is asked
whether the item that key named is still there; gone is abandon.

**Escalation.** The Ticket goes `escalated`; its Feature and its Project are
frozen. The Ticket's directory is kept for inspection. The emitter reports the
reason, the Trace, and the bound counters, and reminds periodically while nobody
answers; there is no time limit. On `resume`: a Ticket restarts from zero; an
escalation born in `merging` returns to `integrating`. A Feature's line refused
by the Authority escalates the Feature the same way and, on `resume`, is
submitted again.

**An intention edited while in flight** is recorded; at the end of the current
Ticket it escalates so a human decides. In `merging` the edit is refused as too
late (`reject_late`). An edit is a change to the words of the intention, as the
tracker reads them — not a comment, a label, or a box ticked on a checklist;
each manager says what its tracker's own furniture is (manager-github: SPECS §3b).

**Abandon**, by where a Ticket stands:

| Ticket is…                         | Result                                                                                                                                                                                                                     |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| not started                        | `cancelled`; nothing on disk                                                                                                                                                                                               |
| started, before `merging`          | the Implementer is interrupted, the directory is kept and named to the tracker for a human to recover, the Ticket is `cancelled`                                                                                            |
| in `merging`, or escalated from it | **refused** — point of no return. Only `resume` moves it, back to `integrating`                                                                                                                                             |
| `done`                             | too late; no revert. Reported as arrived after integration, with the integration reference                                                                                                                                 |

Abandoning a Feature cancels all its Tickets that are not `done` and deletes its
line. A Feature whose line is in `merging` is refused the same way.

**Conflicts** are never forced: a Ticket into its Feature's line escalates the
Ticket; a Feature's line into the final line escalates the Feature.

**Events** the emitter writes back, each carrying the item's external identity,
its Project, and a timestamp. A Ticket's events go to the TicketTracker, a
Feature's to the FeatureTracker. The form (a comment, a label, a status) is the
tracker's; the meaning is fixed:

| Event                 | When                                                                   | Carries                                                                                                       |
| --------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `invalid`             | the Adapter could not convert                                          | what is missing or unreadable                                                                                 |
| `accepted`            | a Ticket written as `received`; a Feature opened                       | the priority retained                                                                                         |
| `progress`            | a Ticket reaches `done`, on its Feature; a refused Submission is being repaired | one sentence: what landed and how far along ("Landed 1 of 3: …"), or who refused and what happens next |
| `escalated`           | entering `escalated`                                                   | reason, stage (unit / integrating / submitting / merging), Trace, counters, "the Ticket is frozen"            |
| `escalation_reminder` | an escalation left unanswered                                          | the same diagnosis, "still waiting"                                                                           |
| `resumed`             | `resume` taken into account                                             | where it resumes (`running` / `integrating`)                                                                  |
| `submitted`           | the assembled Ticket, or the Feature's line, is in front of the Authority | where it can be seen — the Submission reference                                                            |
| `done`                | folded into its line                                                   | the Submission reference and the line's own name for the fold (a commit) when there was an Authority; nothing to open otherwise — never a path on the operator's machine |
| `cancelled`           | abandon accepted                                                       | the state at that moment; the kept directory when work was partial                                            |
| `reject_late`         | abandon or edit in `merging` / `done`                                  | "too late", the integration reference when `done`                                                             |

These events are the whole human surface: nobody should need to open the
WorkLedger to know where a Ticket stands. What the WorkLedger must let an
operator see, for the system to be operable at all: every state, every blocker,
the Ticket `running` and since when; the reason and Trace of the last
escalation; the source intention; the bound counters consumed.

## What success means

1. Every admitted Ticket and Feature reaches an explicit state — `done`,
   `cancelled`, `escalated`, or `invalid` — never a silent limbo.
2. Nothing enters a line without a validated Ticket **and** a judged assembly.
3. The FeatureTracker, the TicketTracker, the isolation method, the persistence,
   the Builder are interchangeable without touching the kernel.
4. A human is asked only on escalation, abandon, integration conflict, an
   invalid intention, or the merge of a Feature's line — always in a tracker,
   with a Trace when there is one.
5. After an escalation is answered, resume is unambiguous: from zero on the
   Ticket concerned, or `integrating` when it was born in `merging`.
6. A crash or restart is recoverable: lease plus WorkLedger as the source of
   truth, nothing on disk decides.

This document stays at the level of the workflow. It names no stack, no API
shape, no Builder or Gate implementation; that is what each package's
`SPECS.md` is for.

## Glossary

The words used in code, database columns, UI, and conversation. One row per concept.
If two words mean the same thing, pick one and mark the other as an alias to retire.

| Term | Means | Does **not** mean | Where it lives in code |
| --- | --- | --- | --- |
| FeatureTracker | External tool where Features live (a need, in the product's words). A human surface | The WorkLedger; any internal store; a Ticket tracker | A manager package (`packages/plugins/manager-*`) |
| TicketTracker | External tool where Tickets live (the work to build, in the code tracker). A human surface | The WorkLedger; the FeatureTracker; the Authority | A manager package |
| Authority | Outside holder of the lines: it opens a Feature's line, takes a Submission and folds it once the Gates accept. It does not judge. Optional: with none, WorkLineStable is the reference | A Gate; a tracker's reporting surface; a human on the happy path | A manager package (`openLine`, `submit`, `verdict`, `fold`) |
| Listener / Adapter / Emitter | The three parts of a manager: subscribe to events (`listen`), turn a raw item into a Standard (`adapt`), report semantic events back (`report`) | A generic HTTP client; logging; the WorkLedger | Inside a manager package |
| Project | Target of work: owns WorkLineStable, one Gate sequence, and the bounds | A git repository by itself | `mason.config.yaml`, read by `packages/host/runtime` |
| Feature | The functional unit: a need with a title, an intention, a priority, the Features that block it, and the signals `feature-ready` and `merge-when-ready`. Has Tickets and one line | A Ticket; a unit of work a Builder runs | A FeatureTracker; `FeatureStandard` in `manager-kit` |
| FeatureStandard | A Feature normalized: external identity, Project, intention, priority, blockers, signals, state | A raw tracker item; a TicketStandard | Adapter OUT; `manager-kit` types |
| Ticket | The technical unit bluewombat builds: one unit of work, in one isolated workspace, validated by Gates, landed as one change on its Feature's line | A Feature; a step of a plan (there is none) | A TicketTracker; `TicketStandard` in `manager-kit` |
| TicketStandard | A Ticket normalized: external identity, Feature, Project, intention, priority, blockers, the signal `task-ready`, state, bounds counters | A Feature; a raw tracker item | Adapter OUT; `manager-kit` types |
| e2e Ticket | The last Ticket of a Feature, labelled `e2e` on the tracker: its body is the Feature's scenarios (`E1`, `E2`…, five at most), copied verbatim; it writes the acceptance suite and the manifest `e2e/scenarios.json` and nothing else | A Ticket that runs the suite (a Gate does, once, on the whole Feature); a test written first for another Ticket | A TicketTracker (`TicketEntry.e2e`); `builder.e2e` |
| Acceptance suite | The end-to-end tests of one Feature, one test per scenario id of its manifest, run once on the assembled Feature line by the `e2e` Gate against the Project's own commands (`up`, `ready`, `run`, `down`) | A unit test; a suite per Ticket; the Project's CI | `e2e/` of the Project; `gates/e2e.mjs` |
| Line | A Feature's branch, cut from the Project's final line when the Feature opens. Tickets land on it; it is submitted whole when they are all `done` | The final line; a Ticket's own branch | Named by the Authority (`openLine`) |
| Stage | Where an escalation stopped, as an Event field: `unit` (the Ticket's Attempts), `integrating` (the assembled Ticket), `submitting` (the Submission: the offer refused before one existed, or one under review in state `submitted`), `merging` (the fold) | A state; a Transformer | `manager-kit` (`EventFields`) |
| WorkLedger | Store of Features, Tickets, states, Attempts, and Traces. System source of truth | A tracker; a workspace on disk; a visual task board | `packages/kernel/work-ledger` |
| Attempt | One execution pass of a Ticket (Builder + Gate sequence). Numbered, tied to a Trace | A Gate; a retry counter with no artifact | `packages/kernel/implementer` |
| Trace | What an Attempt leaves so a human can understand without replaying: input, Builder output, Gate verdicts, failure reason | Application logs | `packages/kernel/implementer` |
| Conductor | Glue that sequences Transformers for one Ticket and closes a Feature (bail, loop, pause). Not Transformer-shaped | A Transformer that creates directories or runs Attempts | `packages/kernel/conductor` |
| Host | The process: Cursor, admission, Conductor, report. Loads the manager packages. Does not know a tracker | A Transformer; a tracker | `packages/host/runtime` |
| Manager kit | The manager plugin contract: the Ports a manager package implements | Host; a Transformer | `packages/host/manager-kit` |
| Manager package | Composition root for one tracker: exports `createManager`, speaks the Ports it answers (`FeatureTrackerPort`, `TicketTrackerPort`, `AuthorityPort`) | The Transformers it wires; Host | `packages/plugins/manager-*` |
| Implementer | Runs one Task in an existing directory: Builder, then Gates, until success or bounds. Does not create or delete the directory | The glue; the Builder | `packages/kernel/implementer` |
| Isolator | One parent directory in; one isolated child directory out. That path is Implementer's `--workspace` | Integrator; Implementer; WorkLineStable | `packages/kernel/isolator` |
| Integrator | Merges a child directory into a parent directory. Never forced: `integrated` or `conflict` | Isolator; Implementer | `packages/kernel/integrator` |
| Builder | Opaque producer that realizes a Ticket in an isolated workspace | A Gate; the Conductor | A slot: `packages/plugins/slots`, spawned by Implementer |
| Gate | Validation step in the Project's ordered sequence. Verdicts: `pass`, `fail-retryable`, `fail-blocking` | A human approval step on the happy path | A slot: `packages/plugins/slots`, spawned by Implementer |
| WorkLineStable | The system's copy of the line Tickets land on: the Feature's line while a Feature is open, the final line otherwise | A workspace the system creates; the Submission; the Authority's own copy | Host `workLine.stable`, or `<home>/work-line` copied from the manager's reference |
| Submission | An assembled Ticket, or a Feature's line, placed where the Authority can judge it. Carries an opaque reference the system does not read | The fold itself; a report; a human approval step; the state `submitted` | `manager-kit` types; a manager package |
| submitted | Ticket or Feature state: the work is with the Authority, waiting for a verdict (for a Feature without `merge-when-ready`, for a human's merge) | The Submission (the offer); `merging`; a Gate that happens to wait | `packages/kernel/work-ledger` (`TicketState`, `FeatureState`) |
| WorkSpaceTicket | Isolated directory for one Ticket, Isolator OUT from WorkLineStable | WorkLineStable | `<workspaceRoot>/<ticket>`, made by Isolator for Conductor |
| Escalate | Freeze the Ticket, hence its Feature, pending a human, with a Trace when an Attempt exists | A retry; a silent timeout | Host + Emitter (`escalated`) |
| Resume | Human signal in a tracker that authorizes resume | `feature-ready`, `task-ready` (those open work, they do not resume it) | Whatever that manager's `signalsResume` reads |
| Transformer | Independent unit under `packages/kernel/` (e.g. `isolator`): one IN, one OUT, own binary and CLI. Shared contract in `packages/kernel/README.md` (§ Transformers) | An example; an integration assembly; a shared library every Transformer must import | `packages/kernel/{isolator,implementer,integrator}` |
| Port | A contract injected into a kernel piece by whoever wires it — Transformer Port, Authority Port, Manager Ports, Persist Port. The build vocabulary is in ARCHITECTURE.md, "Vocabulary" | A Plugin (its implementation); a Slot | `conductor/src/transformers/port.ts`; the kits |
| Plugin | A package a config names and Host loads at run time: a manager, an isolation strategy, a persistence backend | A Slot (spawned, never imported); a Transformer | `packages/plugins/{manager,isolation,persist}-*` |
| Slot | An opaque command a config names and the system spawns — Builder, Gate, Publisher, Refresher, Describer. One JSON line out | A Plugin; a Transformer | `packages/plugins/slots/**`, any script |
| bluewombat | The system as a whole: the packages `@bluewombat/*`, the rules, the words in this document | A command; a package name on its own | The repository `tilap/bluewombat`; the npm scope |
| mason | The command-line tool the operator runs — `init`, `doctor`, `setup`, `run`, `watch`, `status`, `cancel` — and the name on what it owns: `mason.config.yaml`, `.mason/`, the tracker labels | The system, a package, or a branch: a Ticket's branch is `issue/<n>` | `PRODUCT` in `packages/host/manager-kit/src/product.ts`; `bin` of `@bluewombat/runtime` |

Rules:

- A term used in code but absent here is a documentation gap.
- A term here with no code location is either dead or not built yet — say which.
- Renaming a domain term is a decision: record it in [DECISIONS.md](./DECISIONS.md) before
  the rename, not after.

## Out of scope

What this product deliberately does not do, so the question stops coming back.

- The business content of what is produced (code, chapter, design, or anything else)
- Choosing a concrete FeatureTracker, TicketTracker, versioning tool, or Builder
- Everything after the final line (release, deploy, final publication)
- Automatic revert or repair of a Ticket already landed
- Splitting a Ticket into smaller units: the Ticket is the unit
- Concurrent Features on the same Project (they are serialized)
- A shared runtime library that Transformers import
- Documenting a Transformer's internals or CLI in root `docs/`

## Detailed specifications

No issue tracker is linked yet. This document is the product: the workflow,
its rules, and its words, tool-agnostic on purpose — the same rules would run a
book. The states and transitions in full are the WorkLedger's
[`SPECS.md`](../packages/kernel/work-ledger/SPECS.md); the sequencing, the
Conductor's; who exists and who invokes whom, [`packages/README.md`](../packages/README.md).
Update this document when a product fact changes, before the code does.
