---
title: Product and domain
summary: What bluewombat does, who uses it, the domain rules, and the vocabulary the code must follow.
covers: []
---

# Product and domain

> Scope: what the code cannot tell you. Roles, rules, and vocabulary.
> Detailed feature specifications live in the tracker — link them, do not copy them here.

## What it does

bluewombat is an autonomous project-execution system. A human states an intention in an
external FeatureManager. The system normalizes that intention, breaks it into Subtasks,
executes them one at a time in isolated workspaces, validates each unit through a
Project-defined sequence of Gates, then integrates the finished feature into
WorkLineStable. When the Project has an Authority, the assembled feature waits
in `submitted` until that Authority accepts it; only then does it enter the
work line.

On the happy path there is no human in the loop. The human is an escape hatch: they
read, correct, abandon, and signal `ready` only in the FeatureManager, with a Trace
when work has already been attempted.

The operator meets the system as one command-line tool, **mason**: `mason init`
sets a Project up, `mason run` is the process that listens, plans, builds,
validates and folds, `mason watch`, `status`, `doctor`, `setup`, `cancel` are
its levers. bluewombat is the whole — the packages, the rules, the words; mason
is the name on the binary, the config file, the home directory, and the labels
it writes on a tracker.

The repository is three groups of packages — kernel, host, plugins — on one
TypeScript toolchain. This document is the product: the workflow, its rules,
and its words, with no stack in it. A package's binary and CLI are documented
next to that package. The stack is [DEVELOPMENT.md](./DEVELOPMENT.md).

## Who uses it

| Role                 | Needs                                                                | Can do                                                                        | Cannot do                                                                |
| -------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Human (project team) | A delivered result, or a clear block with a Trace                    | Create, edit, and abandon intentions; answer escalations; signal `ready`      | Drive the happy path; open the WorkLedger to know where a feature stands |
| FeatureManager       | To remain the only human surface                                     | Host raw intentions and receive emitter events                                | Execute work or hold system truth                                        |
| bluewombat (this system) | A FeatureStandard it can plan and run                                | Listen, normalize, break down, execute, validate, integrate, escalate, report | Invent business content; revert a feature already in WorkLineStable      |
| Builder              | A Subtask intention, a definition of done, and an isolated workspace | Produce the unit of work                                                      | Integrate; talk to the FeatureManager; decide Gate verdicts              |

## Domain rules

Business invariants that must hold regardless of implementation. Each one should be
falsifiable — if code violates it, that is a bug, not a design choice.

- One FeatureStandard belongs to exactly one Project.
- A Project runs at most one active FeatureStandard at a time. Distinct Projects may
  run in parallel.
- Inside a feature, Subtasks run one at a time. The dependency graph chooses order;
  it does not authorize parallelism.
- Nothing enters WorkLineStable unless every Subtask passed the Project's Gate
  sequence for a Subtask, **and** the assembled feature was judged — by its own
  Gate sequence, by the Authority, or by both. The two sequences are separate:
  a check that is right for one unit of work can be wrong for the whole.
- Durable state is written to the WorkLedger before it is acted on. Isolated workspaces
  are a consequence of that state, never the source of it.
- After FeatureBreakdown accepts a plan, the plan is frozen. Automatic re-breakdown
  of an in-flight feature is forbidden.
- A Gate has three verdicts only: `pass`, `fail-retryable`, `fail-blocking`. The first
  non-pass stops the sequence. A retryable failure starts a new Attempt from the
  **first** Gate, not from the one that failed.
- A Subtask is valid only when every Gate passes in the **same** Attempt.
- `fail-blocking` escalates immediately and does not consume remaining Attempts.
- Escalation freezes the whole feature. Resume of a Subtask after `ready` starts from
  zero; no opaque half-result is reused.
- When the Project has an Authority, an assembled feature enters `submitted`.
  It enters `merging` only once the assembly Gate sequence has passed on it. A
  refusal carries a report and feeds the next Attempt, exactly as any other Gate
  refusal does; it is not a second failure path. `submitted` survives a restart;
  the feature is still in flight.
- An accepted Submission moves the work line. The system's copy is brought up to the
  Authority's state before the next Isolation, so later work starts from the new version.
- Entering `merging` is a point of no return: abandon and intention edits are refused.
  The only allowed human action is `ready`, which returns the feature to `integrating`.
- An integrated Subtask is never undone. A later Subtask that proves earlier work
  wrong escalates the FeatureStandard.
- Bound breaches (Attempts, duration, budget, plan size) escalate. They never fail
  silently.
- Admission is idempotent on the external identity (manager + origin id). A duplicate
  event does not restart work that already exists.
- A Transformer does not depend on another Transformer, and a Transformer does not import a
  kernel sibling or a plugin. Wiring several Transformers together happens in Host
  (execution) or in a manager package (one tracker).

## Bounds, leases, and stopping

Every bound is the Project's, and a breach escalates — never a silent failure:

- Subtasks per feature; Attempts per Subtask;
- duration of an Attempt, of a Subtask, of a FeatureStandard;
- a resource budget per FeatureStandard, opaque at this level.

Every feature or Subtask in flight holds a **lease** (a duration, renewed while
work goes on). An expired lease makes the unit recoverable: the Subtask returns
to `runnable`, its isolated directories are destroyed, and the next pass starts
from zero and consumes an Attempt. At startup the system **reconciles** isolated
directories against the WorkLedger and destroys every orphan; the WorkLedger
decides, never the disk.

Two ways to stop. A **pause** admits nothing new and starts no Subtask; the
current one runs to its end and nothing is folded into WorkLineStable. An
**emergency stop** interrupts the Implementer; affected Subtasks return to
`runnable` and their directories are destroyed.

## The human surface

A human acts in three cases only — escalation, abandon (including a deletion on
the FeatureManager side), and a corrected intention — and always through the
FeatureManager. A poll cannot see a deletion: the item is missing from every
later page. The FeatureManager is asked whether the intention that key named
is still there; gone is abandon.

**Escalation.** The Subtask and/or the FeatureStandard go `escalated`; the whole
feature is frozen. The Subtask's directories are kept for inspection. The
emitter reports the reason, the Trace, and the bound counters, and reminds
periodically while nobody answers; there is no time limit. On `ready`: a plan
escalation returns to `planning` and the breakdown is replayed; a Subtask
escalation restarts that Subtask from zero, integrated ones untouched; an
escalation born in `merging` returns to `integrating`. When the plan itself is
wrong and the feature is not in `merging`, the answer is abandon and recreate —
never a re-breakdown in flight.

**An intention edited while in flight** is recorded and does not touch the
frozen plan; at the end of the current Subtask the feature escalates so a human
decides. In `merging` the edit is refused as too late (`reject_late`). An edit
is a change to the words of the intention, as the FeatureManager reads them —
not a comment, a label, or a box ticked on a checklist; each manager says what
its tracker's own furniture is (manager-github: SPECS §3b).

**Abandon**, by where the feature stands:

| Feature is…                        | Result                                                                                                                                                                                                                     |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| not started (no Subtask)           | `cancelled`; nothing on disk                                                                                                                                                                                               |
| started, before `merging`          | the Implementer is interrupted, Subtask directories destroyed, remaining Subtasks cancelled, feature `cancelled`. The feature directory is never folded; it is kept and named to the FeatureManager for a human to recover |
| in `merging`, or escalated from it | **refused** — point of no return. Only `ready` moves it, back to `integrating`                                                                                                                                             |
| `done`                             | too late; no revert. Reported as arrived after integration, with the integration reference                                                                                                                                 |

**Conflicts** are never forced: Subtask into feature escalates the Subtask;
feature into WorkLineStable escalates the feature.

**Events** the emitter writes back, each carrying the feature's external
identity, its Project, and a timestamp. The form (a comment, a label, a status)
is the FeatureManager's; the meaning is fixed:

| Event                 | When                                                                   | Carries                                                                                                       |
| --------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `invalid`             | the Adapter could not convert                                          | what is missing or unreadable                                                                                 |
| `accepted`            | written as `received`, admitted                                        | the priority retained                                                                                         |
| `planned`             | FeatureBreakdown accepted                                              | the plan: Subtasks and dependencies                                                                           |
| `progress`            | a Subtask reaches `integrated`; a refused Submission is being repaired | one sentence: what landed and how far along ("Landed 1 of 2: …"), or who refused and what happens next        |
| `escalated`           | entering `escalated`                                                   | reason, stage (plan / unit / integrating / submitting / merging), Trace, counters, "the feature is frozen" |
| `escalation_reminder` | an escalation left unanswered                                          | the same diagnosis, "still waiting"                                                                           |
| `resumed`             | `ready` taken into account                                             | where it resumes (`planning` / `running` / `integrating`)                                                     |
| `submitted`           | the assembled feature is in front of the Authority                     | where it can be seen — the Submission reference                                                               |
| `done`                | folded into WorkLineStable                                             | the Submission reference and the work line's own name for the fold (a commit) when there was an Authority; nothing to open otherwise — never a path on the operator's machine |
| `cancelled`           | abandon accepted                                                       | the state at that moment; the kept feature directory when work was partial                                    |
| `reject_late`         | abandon or edit in `merging` / `done`                                  | "too late", the integration reference when `done`                                                             |

These events are the whole human surface: nobody should need to open the
WorkLedger to know where a feature stands. What the WorkLedger must let an
operator see, for the system to be operable at all: every state, every
dependency, the unit `running` and since when; the reason and Trace of the last
escalation; the source intention; the bound counters consumed.

## What success means

1. Every admitted intention reaches an explicit state — `done`, `cancelled`,
   `escalated`, or `invalid` — never a silent limbo.
2. Nothing enters WorkLineStable without validated Subtasks **and** a judged
   assembly.
3. The FeatureManager, the isolation method, the persistence, the Builder are
   interchangeable without touching the kernel.
4. A human is asked only on escalation, abandon, integration conflict, or an
   invalid intention — always in the FeatureManager, with a Trace when there is
   one.
5. After an escalation is answered, resume is unambiguous: from zero on the
   unit concerned, or `integrating` when it was born in `merging`.
6. A crash or restart is recoverable: lease plus WorkLedger as the source of
   truth, nothing on disk decides.

This document stays at the level of the workflow. It names no stack, no API
shape, no Builder or Gate implementation; that is what each package's
`SPECS.md` is for.

## Glossary

The words used in code, database columns, UI, and conversation. One row per concept.
If two words mean the same thing, pick one and mark the other as an alias to retire.

| Term             | Means                                                                                                                                                                        | Does **not** mean                                                                       | Where it lives in code                                                            |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| FeatureManager   | External tool where raw intentions live; the only human surface                                                                                                              | The WorkLedger; any internal store                                                      | A manager package (`packages/plugins/manager-*`)                                  |
| FeatureListener  | Subscribes to FeatureManager events (create, update, `ready`, cancel, delete)                                                                                                | The component that converts or executes                                                 | Inside a manager package (`listen`)                                               |
| FeatureAdapter   | Turns a raw intention into a FeatureStandard; may fetch extra context                                                                                                        | A generic HTTP client                                                                   | Inside a manager package (`adapt`)                                                |
| FeatureEmitter   | Reports semantic events back to the FeatureManager                                                                                                                           | Logging; the WorkLedger                                                                 | Inside a manager package (`report`)                                               |
| Project          | Target of work: owns WorkLineStable, one Gate sequence, and the bounds                                                                                                       | A git repository by itself                                                              | `mason.config.yaml`, read by `packages/host/runtime`                              |
| FeatureStandard  | Normalized intention: external identity, Project, intention, priority, state, bounds counters                                                                      | A Subtask; a raw tracker ticket                                                         | Adapter OUT; `manager-kit` types                                                  |
| Subtask          | Executable unit of a FeatureStandard, with dependencies inside that feature only                                                                                             | A standalone job; a FeatureStandard                                                     | `packages/kernel/feature-breakdown`                                               |
| Stage            | Where an escalation stopped, as an Event field: `plan` (the Plan was refused, or the intention edited in flight), `unit` (a Subtask), `integrating` (the assembled feature), `submitting` (the Submission: the offer refused before one existed, or one under review in state `submitted`), `merging` (the fold)| A FeatureStandard state; a Transformer                                                  |
| WorkLedger       | Store of FeatureStandards, Subtasks, states, Attempts, and Traces. System source of truth                                                                                    | The FeatureManager; a workspace on disk; a visual task board                            | `packages/kernel/work-ledger`                                                     |
| Attempt          | One execution pass of a Subtask (Builder + Gate sequence). Numbered, tied to a Trace                                                                                         | A Gate; a retry counter with no artifact                                                | `packages/kernel/implementer`                                                     |
| Trace            | What an Attempt leaves so a human can understand without replaying: input, Builder output, Gate verdicts, failure reason                                                     | Application logs                                                                        | `packages/kernel/implementer`                                                     |
| FeatureBreakdown | Turns a FeatureStandard into Subtasks and dependencies. May refuse → escalate                                                                                                | Re-planning an in-flight feature                                                        | `packages/kernel/feature-breakdown`                                               |
| Conductor        | Glue that sequences Transformers for one FeatureStandard (bail, loop, pause). Not Transformer-shaped                                                                         | A Transformer that creates directories or runs Attempts                                 | `packages/kernel/conductor`                                                       |
| Host             | The process: Cursor, admission, Conductor, report. Loads one manager package. Does not know a tracker                                                                        | A Transformer; a FeatureManager                                                         | `packages/host/runtime`                                                           |
| Manager kit      | The FeatureManager plugin contract: types a manager package implements                                                                                                       | Host; a Transformer                                                                     | `packages/host/manager-kit`                                                       |
| Manager package  | Composition root for one FeatureManager triplet: exports `createManager`, speaks `ManagerPort`                                                                               | The Transformers it wires; Host                                                         | `packages/plugins/manager-*`                                                      |
| Implementer      | Runs one Task in an existing directory: Builder, then Gates, until success or bounds. Does not create or delete the directory                                                | The glue; the Builder                                                                   | `packages/kernel/implementer`                                                     |
| Isolator         | One parent directory in; one isolated child directory out. That path is Implementer's `--workspace`                                                                          | Integrator; Implementer; WorkLineStable                                                 | `packages/kernel/isolator`                                                        |
| Integrator       | Merges a child directory into a parent directory. Never forced: `integrated` or `conflict`                                                                                   | Isolator; Implementer                                                                   | `packages/kernel/integrator`                                                      |
| Builder          | Opaque producer that realizes a Subtask in an isolated workspace                                                                                                             | A Gate; the Conductor                                                                   | A slot: `packages/plugins/slots`, spawned by Implementer                          |
| Gate             | Validation step in the Project's ordered sequence. Verdicts: `pass`, `fail-retryable`, `fail-blocking`                                                                       | A human approval step on the happy path                                                 | A slot: `packages/plugins/slots`, spawned by Implementer                          |
| WorkLineStable   | Pre-existing "already good" work line into which finished features integrate. The system's copy of it when an Authority holds the reference                                  | A workspace the system creates; the Submission; the Authority's own copy                | Host `workLine.stable`, or `<home>/work-line` copied from the manager's reference |
| Authority        | Outside holder of the reference work line: it takes a Submission and folds it once the Gates accept. It does not judge. Optional: with none, WorkLineStable is the reference | A Gate; the FeatureManager's reporting surface; a human on the happy path               | A manager package (`submit`, `fold`)                                              |
| Submission       | An assembled feature placed where the Authority can judge it. Carries an opaque reference the system does not read                                                           | The fold itself; a report; a human approval step; the FeatureStandard state `submitted` | `manager-kit` types; a manager package                                            |
| submitted        | FeatureStandard state: the assembled feature is with the Authority, waiting for a verdict                                                                                    | The Submission (the offer); `merging`; a Gate that happens to wait                      | `packages/kernel/work-ledger` (`FeatureState`)                                    |
| WorkSpaceFeature | Isolated directory for one feature, Isolator OUT from WorkLineStable                                                                                                         | WorkLineStable; a Subtask directory                                                     | `<workspaceRoot>/<feature>`, made by Isolator for Conductor                       |
| WorkSpaceSubtask | Isolated directory for one Subtask, Isolator OUT from the current WorkSpaceFeature                                                                                           | The feature directory after Integrator                                                  | `<workspaceRoot>/<feature>/<subtask>`, the same way                               |
| Escalate         | Freeze the whole feature pending a human, with a Trace when an Attempt exists                                                                                                | A retry; a silent timeout                                                               | Host + FeatureEmitter (`escalated`)                                               |
| Ready            | Human signal in the FeatureManager that authorizes resume                                                                                                                    | Subtask state `runnable`                                                                | Whatever that manager's `signalsReady` reads                                      |
| runnable         | Subtask state: dependencies resolved, waiting for its turn                                                                                                                   | The human `ready` signal                                                                | `packages/kernel/work-ledger` (`SubtaskState`)                                    |
| Transformer      | Independent unit under `packages/kernel/` (e.g. `isolator`): one IN, one OUT, own binary and CLI. Shared contract in `packages/kernel/README.md` (§ Transformers)            | An example; an integration assembly; a shared library every Transformer must import     | `packages/kernel/{isolator,implementer,integrator,feature-breakdown}`             |
| Port             | A contract injected into a kernel piece by whoever wires it — Transformer Port, Authority Port, Manager Port, Persist Port. The build vocabulary is in ARCHITECTURE.md, "Vocabulary"| A Plugin (its implementation); a Slot                                                   | `conductor/src/transformers/port.ts`; the kits                                    |
| Plugin           | A package a config names and Host loads at run time: a manager, an isolation strategy, a persistence backend                                                                 | A Slot (spawned, never imported); a Transformer                                         | `packages/plugins/{manager,isolation,persist}-*`                                  |
| Slot             | An opaque command a config names and the system spawns — Planner, Builder, Gate, Publisher, Refresher, Describer. One JSON line out                                          | A Plugin; a Transformer                                                                 | `packages/plugins/slots/**`, any script                                           |
| bluewombat       | The system as a whole: the packages `@bluewombat/*`, the rules, the words in this document                                                                                    | A command; a package name on its own                                                    | The repository `tilap/bluewombat`; the npm scope                                  |
| mason            | The command-line tool the operator runs — `init`, `doctor`, `setup`, `run`, `watch`, `status`, `cancel` — and the name on what it owns: `mason.config.yaml`, `.mason/`, the tracker labels | The system, a package, or a branch: a branch is `issue/<n>`                             | `PRODUCT` in `packages/host/manager-kit/src/product.ts`; `bin` of `@bluewombat/runtime` |

Rules:

- A term used in code but absent here is a documentation gap.
- A term here with no code location is either dead or not built yet — say which.
- Renaming a domain term is a decision: record it in [DECISIONS.md](./DECISIONS.md) before
  the rename, not after.

## Out of scope

What this product deliberately does not do, so the question stops coming back.

- The business content of what is produced (code, chapter, design, or anything else)
- Choosing a concrete FeatureManager, versioning tool, or Builder
- Everything after the integration work line (release, deploy, final publication, and folding that
  line onto a reference line such as `main`)
- Automatic revert or repair of a feature already in WorkLineStable
- Parallel Subtasks inside one feature
- Automatic re-breakdown of an in-flight feature
- Concurrent features on the same Project (they are serialized)
- A shared runtime library that Transformers import
- Documenting a Transformer's internals or CLI in root `docs/`

## Detailed specifications

No issue tracker is linked yet. This document is the product: the workflow,
its rules, and its words, tool-agnostic on purpose — the same rules would run a
book. The states and transitions in full are the WorkLedger's
[`SPECS.md`](../packages/kernel/work-ledger/SPECS.md); the sequencing, the
Conductor's; who exists and who invokes whom, [`packages/README.md`](../packages/README.md).
Update this document when a product fact changes, before the code does.
