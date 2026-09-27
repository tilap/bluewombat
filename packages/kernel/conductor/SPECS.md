# Conductor

Not a Transformer. It has many operations, not one IN and one OUT.
It sequences other people's jobs: WorkLedger commands, Isolation, Breakdown,
Implementer, Integration. It does not store FeatureStandards, does not isolate a
directory, does not split a Plan, does not run a Builder, does not fold a Child,
and does not report to a FeatureManager.

Conductor writes the WorkLedger **before** it acts. Isolated workspaces are a
consequence of that state, never the source of it.

## 1. Job

```
  caller                         Conductor                         others
  ------                         ---------                         ------
  run a Project                  check pause, reconcile            WorkLedger
                                 claim or resume                   isolate / breakDown
                                 write ledger, then act            implement / integrate
                             ←   idle | done | escalated | paused | refused
```

**In:** an opened WorkLedger, injected transformers, a WorkLineStable path, a workspace
root, and a Project. **Out:** a typed result. No JSON lines, no exit code, no
Status protocol. Those belong to Transformers. This package is a function set imported
in process.

There is no required CLI. If a CLI appears later, it is a thin adapter over the
same functions.

## 2. Faces and wiring

| Face   | Entry                                                              | Must not                                         |
| ------ | ------------------------------------------------------------------ | ------------------------------------------------ |
| Import | `openConductor({ ledger, transformers, workLineStable, workspaceRoot })` | Import a Transformer package from `src/run/`           |
| Transformers | A value that implements the Transformer Port                             | Live under `src/run/` as a concrete Transformer import |

The caller builds the transformers (`runIsolator`, `runBreakdown`, `runImplementer`,
`runIntegrator`, closed over Planner / Builder / Gate argv) and passes them in.
Conductor does not import `@bluewombat/isolator` (or the other three) from its
run loop. The composition root that wires Transformers is the caller — Host
(`packages/host/runtime`) — or a later thin adapter in this package.

Transformers do not import this package. WorkLedger does not import this package.

## 3. Two layers

```
  run loop                    src/run/             order, pause, reconcile,
                                                   ledger-before-act, path choice
           │
           │  Transformer Port + WorkLedger
           ▼
  transformers / ledger             injected             Isolation, Breakdown, Attempts,
                                                   Integration, durable state
```

| Layer     | Owns                                                        | Does not own                                     |
| --------- | ----------------------------------------------------------- | ------------------------------------------------ |
| Conductor | Order of steps, pause, orphan destroy, when to call whom    | FeatureStandard transitions, git, Builder, Gates |
| Ledger    | Legal transitions, bail, Plan freeze                        | Directories, Transformer outcomes                      |
| Transformers    | One Isolation / Breakdown / Attempt loop / Integration each | WorkLedger commands, pause, claim                |

A caller never talks to Isolator through Conductor internals. It talks to
`runProject`. The run loop never talks to `node:child_process`. It talks to
the Transformer Port. Conductor may use `node:fs` only to **delete** directories it
previously declared (after a successful Integration, on bail expiry, or as
orphan destroy). It does not copy, merge, or create a workspace.

## 4. Isolation

Hard rules. Breaking one is a spec bug, not a refactor.

1. **`src/run/` does not import a Transformer package** (`@bluewombat/isolator`,
   `@bluewombat/implementer`, `@bluewombat/integrator`,
   `@bluewombat/feature-breakdown`). It imports the Transformer Port type and
   WorkLedger types. A test that fails if `run` grows those imports is part of
   this contract.
2. **`src/run/` does not import `work-ledger` persistence adapters.** It talks
   to the WorkLedger command surface the caller opened.
3. **No `if (git)` / `if (copy)` in Conductor.** Isolation strategy is Isolator's.
4. **Domain tests inject a Transformer Port and a WorkLedger.** They may use a
   test-double ledger (in the test file) and fake transformers that record call order.
   They do not require a Transformer `dist/`.
5. **The caller, not Conductor, chooses Planner / Builder / Gate argv.** Those
   slots close over the transformer functions.

## 5. Transformer Port

Four operations. Real Transformers or test doubles; the Port does not care.

| Operation   | In (minimum)                                                                 | Out (minimum)                                                                                       |
| ----------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `isolate`   | `id`, `parent`, `child` (absolute paths), `durationMs`                       | `isolated` / `failed` / `invalid-invocation` / `interrupted`                                        |
| `breakDown` | FeatureStandard JSON (key, intention, optional title) | `planned` + subtasks + `planned_at`, or `refused` + code + reason, or `unavailable` / `interrupted` |
| `implement` | `id`, intention, `workspace`, durations / attempt bound, optional definition of done, `report`, `stage`, `produce` | `validated` / `escalated` / `interrupted` / `invalid-invocation`, plus ordered Traces               |
| `integrate` | `id`, `parent`, `child`, `durationMs`                                        | `integrated` / `conflict` / `failed` / `invalid-invocation` / `interrupted`                         |

Conductor maps ledger fields into `breakDown` JSON. It does not reopen
FeatureAdapter's closed shape. Recognised keys are `key`, `intention`, `title`.

A Subtask carries the `definition_of_done` its Plan gave it. An assembly carries
none: what it must meet is the Subtasks it is made of, and each was judged on its
own.

`stage` says what is being judged — one unit of work, or the feature they
assemble into. They are not the same situation: a check that is right for one can
be wrong for the other. `produce` says whether the Task may make anything: a
stage built only of already-validated work has nothing to make, and asking a
producer to run there is how a correct result gets rewritten so a check expecting
a change is satisfied. `report` is what a pass before this one left unresolved,
and it reaches the producer as any Gate's report does.

`validate` marks a third assembly pass, neither of `produce`'s two: a read-only
judge of the whole, run after align and before offer (or the local judge on
`produce: false`). It answers directly, before there is a Submission or a Gate
sequence to hold a verdict. Absent: `stage` and `produce` decide alone.

A Trace carries `ended` and, when the Attempt did not end well, the `report` of
whatever refused it — the first Gate that did not pass, or the producer's own
detail. `ended` says an Attempt failed; `report` says why, and whoever drives the
next one cannot invent it.

`implement` Traces are Implementer's Traces. Conductor records each Subtask
Trace as a WorkLedger Attempt (`ended`, and `report` / `refusedBy` when the
Attempt did not end well) before it decides escalate vs integrate.

`integrate` may also carry `subject` and `mergeSubject` for the fold's history.
They are not required by the Port's outcome.

An optional **Authority Port** (`submit` / `fold`) is not a transformer. When the
caller injects one, an assembled feature is offered outside instead of being
folded into WorkLineStable by Integrator. `workLineTarget` names that work line
for the Authority. `maxRefusals` (default 3) is how many times the Authority's
Gates may send the work back before Conductor escalates.

## 6. Paths

Constructor: `openConductor({ ledger, transformers, workLineStable, workspaceRoot,
transformerDurationMs?, authority?, workLineTarget?, maxRefusals?,
assemblyValidate?, assemblyFixDeclared?, observe? })`. `assemblyValidate` says
whether a local judge runs after align, with or without an Authority.
`assemblyFixDeclared` says whether a refusal has anything to repair it with; a
validate refusal escalates on the spot when it does not.
`observe` is told, mid-pass, when the plan is recorded, when a Subtask is
integrated (with the count), and when the work is submitted — awaited, and a
throw from it changes nothing about the run.
`workLineStable` and `workspaceRoot` are absolute directories. `workspaceRoot`
must not be `workLineStable`. Conductor does not create `workLineStable`.

Physical layout is this package's private choice:

```
<workspaceRoot>/<encoded-key>/feature
<workspaceRoot>/<encoded-key>/subtask-<encoded-id>
```

`<encoded-key>` and `<encoded-id>` are `encodeURIComponent` so `fake:42` is one
path segment. Conductor never uses the raw key as a directory name.

It **declares** that path on the WorkLedger, **then** calls `isolate`. After
`integrate` of a Subtask returns `integrated`, it deletes the Subtask directory
and `clearWorkspace` for the Subtask. After `markDone`, it deletes the feature
directory and `clearWorkspace` for the feature.

## 7. Commands

Each command is a function on the opened conductor. Illegal input returns
`refused` with a `code`. It does not throw for domain reasons. A refused
command does not start a Transformer.

| Command      | Meaning                                                                                                                                                             | Refused when                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `reconcile`  | `expireBail` on expired keys. Destroy directories under `workspaceRoot` that are not on `listDeclaredWorkspaces`. Delete declared Subtask dirs after expiry.        | Paths not absolute (constructor already threw) |
| `pause`      | In-process flag: no new `claim`, no new `startSubtask`, no `markMerging` / final fold into WorkLineStable. Current `implement` / `isolate` / `integrate` may finish | —                                              |
| `resume`     | Clear the pause flag. Does not itself take work                                                                                                                     | —                                              |
| `runProject` | Reconcile, then take or resume the active FeatureStandard on that Project, and drive it until a terminal or wait state                                              | `workLineStable` missing on disk               |
| `cancel`     | `ledger.cancel(key)` then destroy declared workspaces for that key                                                                                                  | Ledger `point-of-no-return`                    |

`runProject` outcomes:

| Outcome     | Meaning                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------- |
| `idle`      | No `received` FeatureStandard and no active one on that Project                               |
| `done`      | The FeatureStandard is `done` in WorkLineStable                                               |
| `escalated` | Frozen for a human. Isolated Subtask workspace kept when a Subtask was in play                |
| `paused`    | Stopped at a pause boundary. Ledger holds the current state                                   |
| `refused`   | Constructor-level or ledger refusal the loop cannot handle (`persist-failed`, missing stable) |

`runProject` does **not** wait for a human `ready`. After `escalated`, the
caller (FeatureManager path) calls `ledger.resumeReady(key)` then `runProject`
again.

## 8. Happy path (ledger before act)

One FeatureStandard, one Project. Pause flag is off.

1. `reconcile`.
2. If the Project already has an active FeatureStandard, resume it. Else `claim`.
   Empty → `idle`.
3. **Planning.** `breakDown`. On `planned`: `recordPlan` **before** any Isolation.
   On `refused`: `refusePlan`, return `escalated`. On `unavailable`: return
   `refused` with code `unavailable` (ledger stays `planning`; retryable). On
   `interrupted`: return `refused` with code `interrupted`. On
   `invalid-invocation`: return `refused` with code `transformer-invalid`.
4. **Feature workspace.** `declareWorkspace({ feature })` **then** `isolate`
   (parent = WorkLineStable, child = feature path). Failure: do not start
   Subtasks; `runProject` returns `refused` (`isolate-failed` or `transformer-invalid`)
   and leaves the ledger in `running` so a retry isolates again if the directory
   is missing. If a Submission is already recorded and the feature directory is
   gone, Conductor escalates `kind: "submitted"` rather than isolating again
   over what the Authority was shown.
5. **Subtask loop** while `nextRunnable` is a Subtask and pause is off:
   1. `startSubtask`.
   2. `declareWorkspace({ subtask })` **then** `isolate` (parent = feature path).
   3. `implement` in that child.
   4. For each Trace, `recordAttempt` with the next number and that Trace's
      `ended`, plus `report` / `refusedBy` when present.
   5. `validated` → `integrate` child into feature. `integrated` →
      `markSubtaskIntegrated`, delete child, `clearWorkspace` subtask.
      `conflict` → `escalate({ kind: "subtask", subtaskId })`, **keep** the child.
   6. `escalated` from Implementer → `escalate({ kind: "subtask", subtaskId })`
      (Trace already recorded). Keep the child. The next `startSubtask` for
      that id **destroys** the kept Child first (resume from zero).
   7. After a Subtask is marked integrated, if `pending_fingerprint` is set,
      `escalate({ kind: "plan" })` with a report that says the intention was
      edited in flight and what resume does — not that a Plan was refused,
      which is what `kind: "plan"` reads as without it. The ledger consumes
      the pending field. Resume of `kind: "plan"` unfreezes the Plan
      (`resumeReady`). A newer FeatureStandard body lands by `admit` of the
      corrected document (from `escalated` → `received`).
6. When the ledger is `integrating` and pause is off:
   1. If `pending_fingerprint` is set, escalate `kind: "plan"` as in 5.7 and
      stop. Do not align.
   2. If a parked refusal or a Submission `last_report` is set (the parked one
      wins when both are), `implement` on the feature workspace with
      `stage: "assembly"`, `produce: true`, and that report **before** align.
      `escalated` → `escalate({ kind: "assembly" })`.
   3. **Align.** `integrate` with WorkLineStable as **child** and the feature
      workspace as **parent**. `conflict` → return `refused` (`align-conflict`);
      state stays `integrating`. Cancel is still allowed. Retry `runProject`
      retries align. Do not `escalate({ kind: "merging" })` here: that would set
      `born_in_merging` and block cancel before WorkLineStable is the fold parent.
   4. **Validate**, when `assemblyValidate` is set — with or without an
      Authority. `implement` on the feature workspace with `stage: "assembly"`
      and `validate: true` (no gates, one attempt). `validated` →
      `clearParkedRefusal`, then continue to 5 or 6. `escalated`, retryable,
      under `maxRefusals` (the budget shared with `submission.refusals`), and
      `assemblyFixDeclared` → `recordParkedRefusal`, return `paused`. Do not
      continue to 5 or 6. `escalated` otherwise (blocking, at the budget, or no
      `assembly.fix` declared) → `escalate({ kind: "assembly" })`.
   5. **Without an Authority.** `implement` on the feature workspace with
      `stage: "assembly"` and `produce: false` (judgement only). `validated` →
      `markMerging`. `escalated` → `escalate({ kind: "assembly" })`.
      Then **final fold**: `integrate` feature child into WorkLineStable.
      `integrated` → `markDone`, delete feature directory, `clearWorkspace`.
      `conflict` → `escalate({ kind: "merging" })`, keep the feature directory.
   6. **With an Authority.** `submit` the assembled feature. `submitted` →
      `markSubmitted`, return `paused`. `refused` → `escalate({ kind: "submitted" })`
      with the refusal's reason as its report — the Publisher's or the
      Authority's own words, the only record of why the offer failed.
      `unavailable` → return `paused` (retry later). On a later `runProject` in
      `submitted`: judge with `produce: false`. Blocking or over `maxRefusals` →
      `escalate({ kind: "submitted" })`. Retryable refusal → `recordRefusal`
      (which also drops a stale parked refusal, if one is held),
      return `paused` (next pass repairs then aligns, then offers again).
      `validated` → Authority `fold`. `folded` → `markMerging` then `markDone` (with the fold's `reference`, when the Authority named one)
      (the Authority moved the work line; Conductor does not `integrate` into
      WorkLineStable). `conflict` → `escalate({ kind: "submitted" })`.

## 9. Pause and interrupt

Pause is an in-process flag on the opened conductor. It is not stored in the
WorkLedger (pause is Conductor admission, not a FeatureStandard state).

Boundaries where pause is honoured: before `claim`, before `startSubtask`,
before align, before `markMerging`. A running `implement` finishes.

Interrupt is the Transformer Port's problem (the same `interruptFlag` the Transformers
already take). If a transformer returns `interrupted`, Conductor does not mark the
Subtask integrated. It leaves the ledger as the last successful command left
it (typically `running` with that Subtask `running`) and returns `refused`
with code `interrupted`. Reconcile + `expireBail` after process restart is how
that Subtask becomes `runnable` again when the bail expires. First
implementation may also `expireBail` immediately on interrupt if the bail is
already expired; it does not invent a new ledger command.

## 10. Reconcile

After process start, and at the beginning of every `runProject`:

1. `listDeclaredWorkspaces`.
2. Delete any directory under `workspaceRoot` whose absolute path is **not**
   on that list (orphans). Never delete `workLineStable`.
3. `expireBail` for those declared keys, and for `activeOn(project)` when that
   FeatureStandard's bail is past expiry. Then delete a Subtask directory if
   the ledger cleared it.

The ledger decides Feature state. Disk never does. Conductor does not scan
every Project; `runProject` reconciles the workspaces on disk plus the Project
it was asked to run.

## 11. Refusals

| Code             | When                                                             |
| ---------------- | ---------------------------------------------------------------- |
| `stable-missing` | `workLineStable` is not a directory                              |
| `root-invalid`   | `workspaceRoot` is not absolute, or equals `workLineStable`      |
| `persist-failed` | A ledger command returned `persist-failed`                       |
| `interrupted`    | A transformer returned `interrupted`                                   |
| `isolate-failed` | Feature Isolation did not return `isolated`                      |
| `align-conflict` | Align Integration returned `conflict`; state stays `integrating` |
| `transformer-invalid`  | A transformer returned `invalid-invocation`                            |
| `unavailable`    | `breakDown` returned `unavailable` (Planner did not answer)      |

Ledger codes (`project-busy`, `point-of-no-return`, …) pass through on `cancel`
and when `claim` refuses.

## 12. What is implemented

Shipped:

- Import face, `openConductor({ ledger, transformers, workLineStable, workspaceRoot })`
- Optional Authority (`submit` / `fold`), `workLineTarget`, `maxRefusals`
- Optional local `assemblyValidate`, before offer or the local judge, with or
  without an Authority. Its refusal is parked on the aggregate and shares the
  `maxRefusals` budget; `assemblyFixDeclared` says whether it escalates on the
  spot instead
- `reconcile`, `pause`, `resume`, `runProject`, `cancel`
- Happy path: align, assembly judgement (`produce: false`), `markMerging`, final fold
- Authority path: offer, judge, `recordRefusal` / fold, no Integrator fold into WorkLineStable
- `pending_fingerprint` consumed after a Subtask integrates and when entering `integrating`
- Ledger-before-act, declared workspaces, orphan destroy
- Isolation tests in §4
- Pause boundaries

Not shipped:

- FeatureListener / FeatureAdapter / FeatureEmitter (the caller wires them
  through a manager package; Host's suite is the first such assembly)
- CLI
- Persistent pause across processes
- A human `ready` daemon (caller invokes `resumeReady` then `runProject`)
- SQLite, a second workspace layout
- Consuming `pending_fingerprint` while the Feature is `submitted` (admit stores
  it; the next Subtask integrate / integrating entry is what consumes it)

## 13. Layout

```
SPECS.md                 this contract
README.md                how to build and run
src/
  index.ts               openConductor
  transformers/port.ts         Transformer Port only
  run/                   loop, pause, reconcile, paths; imports Port + WorkLedger
```

## 14. Acceptance

1. `runProject` on a Project with one `received` FeatureStandard calls `claim`
   then `breakDown` then `recordPlan` **before** any `isolate`.
2. `declareWorkspace` for the feature path is recorded **before** `isolate` of
   that path. Same for a Subtask path.
3. Fake transformers, one Subtask, all `validated` / `integrated`, no Authority:
   Feature ends `done`; `isolate` was called twice (feature, then Subtask);
   `integrate` was called three times (Subtask fold, align, final fold);
   assembly `implement` ran once on the feature workspace with `produce: false`.
4. `breakDown` `refused` → `refusePlan`; no `isolate`; outcome `escalated`.
5. `implement` `escalated` after Traces → each Trace is `recordAttempt`d;
   then `escalate`; no Subtask `integrate`; child directory not deleted by
   Conductor.
6. Subtask `integrate` `conflict` → `escalate`; child kept.
7. `cancel` of a `running` Feature → ledger `cancelled`; declared directories
   destroyed. `cancel` after `markMerging` → ledger `point-of-no-return`;
   WorkLineStable untouched.
8. A directory under `workspaceRoot` that is not declared is gone after
   `reconcile`. `workLineStable` is never deleted.
9. `pause` after `recordPlan` and feature isolate, before the first
   `startSubtask` → outcome `paused`; no `startSubtask`.
10. `src/run/` has no import of `@bluewombat/isolator`, `@bluewombat/implementer`,
    `@bluewombat/integrator`, or `@bluewombat/feature-breakdown`.
11. Opening Conductor with a Transformer Port test double and a WorkLedger test
    double still passes 1–9. No Transformer `dist/` and no filesystem persist are
    required for those.

Gap, named: align `conflict` leaves `integrating` (`align-conflict`) rather than
a first-class ledger kind. Do not hide that. A later WorkLedger command can
close it. Assembly `escalated` uses `escalate({ kind: "assembly" })`;
`resumeReady` returns that Feature to `integrating`.

## 15. Choices

1. **Not a Transformer.** Sequencing many verbs is not Implementer-shaped.
2. **Injected Transformer Port.** Depending on four Transformer packages would make the
   run loop untestable without `dist/` and would freeze Isolation strategy
   inside Conductor. The caller wires Transformers.
3. **Injected WorkLedger.** Conductor does not open persist. Glue already chose
   the adapter.
4. **Ledger before act, always.** Directories that exist without a declaration
   are orphans and die.
5. **No Emitter in this package.** Reporting is FeatureEmitter. Conductor
   returns a result; the caller reports.
6. **Pause is in-process.** A FeatureStandard state for pause would confuse
   `escalated` and `ready`. Restart clears pause; reconcile + bail remain.
7. **Stack: TypeScript on Node.js 24.20, Biome, `node:test` run through `tsx`.**
   Same as WorkLedger. Recorded here; commands live in this package's README.

How this package is built and run: [README.md](./README.md).
