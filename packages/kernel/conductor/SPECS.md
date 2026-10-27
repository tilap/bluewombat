# Conductor

Not a Transformer. It has many operations, not one IN and one OUT.
It sequences other people's jobs: WorkLedger commands, Isolation, Implementer,
Integration. It does not store TicketStandards, does not isolate a directory,
does not run a Builder, does not fold a Child, and does not report to a
TicketTracker.

Conductor writes the WorkLedger **before** it acts. Isolated workspaces are a
consequence of that state, never the source of it.

## 1. Job

```
  caller                         Conductor                         others
  ------                         ---------                         ------
  run a Project                  check pause, reconcile            WorkLedger
                                 claim or resume                   isolate
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

| Face         | Entry                                                                    | Must not                                               |
| ------------ | ------------------------------------------------------------------------ | ------------------------------------------------------ |
| Import       | `openConductor({ ledger, transformers, workLineStable, workspaceRoot })` | Import a Transformer package from `src/run/`           |
| Transformers | A value that implements the Transformer Port                             | Live under `src/run/` as a concrete Transformer import |

The caller builds the transformers (`runIsolator`, `runImplementer`,
`runIntegrator`, closed over Builder / Gate argv) and passes them in.
Conductor does not import `@bluewombat/isolator` (or the other two) from its
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
  transformers / ledger             injected             Isolation, Attempts,
                                                   Integration, durable state
```

| Layer        | Owns                                                        | Does not own                                     |
| ------------ | ----------------------------------------------------------- | ------------------------------------------------ |
| Conductor    | Order of steps, pause, orphan destroy, when to call whom    | TicketStandard transitions, git, Builder, Gates |
| Ledger       | Legal transitions, bail                                     | Directories, Transformer outcomes                |
| Transformers | One Isolation / Attempt loop / Integration each             | WorkLedger commands, pause, claim                |

A caller never talks to Isolator through Conductor internals. It talks to
`runProject`. The run loop never talks to `node:child_process`. It talks to
the Transformer Port. Conductor may use `node:fs` only to **delete** directories it
previously declared (after a successful Integration, on bail expiry, or as
orphan destroy). It does not copy, merge, or create a workspace.

## 4. Isolation

Hard rules. Breaking one is a spec bug, not a refactor.

1. **`src/run/` does not import a Transformer package** (`@bluewombat/isolator`,
   `@bluewombat/implementer`, `@bluewombat/integrator`). It imports the Transformer Port type and
   WorkLedger types. A test that fails if `run` grows those imports is part of
   this contract.
2. **`src/run/` does not import `work-ledger` persistence adapters.** It talks
   to the WorkLedger command surface the caller opened.
3. **No `if (git)` / `if (copy)` in Conductor.** Isolation strategy is Isolator's.
4. **Domain tests inject a Transformer Port and a WorkLedger.** They may use a
   test-double ledger (in the test file) and fake transformers that record call order.
   They do not require a Transformer `dist/`.
5. **The caller, not Conductor, chooses Builder / Gate argv.** Those
   slots close over the transformer functions.

## 5. Transformer Port

Three operations. Real Transformers or test doubles; the Port does not care.

| Operation   | In (minimum)                                                                                                       | Out (minimum)                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `isolate`   | `id`, `parent`, `child` (absolute paths), `durationMs`                                                             | `isolated` / `failed` / `invalid-invocation` / `interrupted`                                        |
| `implement` | `id`, intention, `workspace`, durations / attempt bound, `report`, `stage`, `produce`                              | `validated` / `escalated` / `interrupted` / `invalid-invocation`, plus ordered Traces               |
| `integrate` | `id`, `parent`, `child`, `durationMs`                                                                              | `integrated` / `conflict` / `failed` / `invalid-invocation` / `interrupted`                         |

`stage` says what is being judged — the unit of work, or the work once
assembled. They are not the same situation: a check that is right for one can
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

`implement` Traces are Implementer's Traces. Conductor records each unit
Trace as a WorkLedger Attempt (`ended`, and `report` / `refusedBy` when the
Attempt did not end well) before it decides escalate vs integrate.

`integrate` may also carry `subject` and `mergeSubject` for the fold's history.
They are not required by the Port's outcome.

An optional **Authority Port** (`submit` / `fold`) is not a transformer. When the
caller injects one, an assembled ticket is offered outside instead of being
folded into WorkLineStable by Integrator. `workLineTarget` names that work line
for the Authority; a Ticket that names its own `line` is offered to that one. `maxRefusals` (default 3) is how many times the Authority's
Gates may send the work back before Conductor escalates.

## 6. Paths

Constructor: `openConductor({ ledger, transformers, workLineStable, workspaceRoot,
transformerDurationMs?, authority?, workLineTarget?, maxRefusals?,
validate?, fixDeclared?, observe? })`. `validate` says
whether a local judge runs after align, with or without an Authority.
`fixDeclared` says whether a refusal has anything to repair it with; a
validate refusal escalates on the spot when it does not.
`observe` is told, mid-pass, when the work is submitted — awaited, and a throw
from it changes nothing about the run.
`workLineStable` and `workspaceRoot` are absolute directories. `workspaceRoot`
must not be `workLineStable`. Conductor does not create `workLineStable`.

Physical layout is this package's private choice:

```
<workspaceRoot>/<key-segment>/ticket
```

`<key-segment>` is one safe path segment: a name made
of letters, digits, `.`, `_` and `-` is kept as it is; anything else becomes a
readable slug plus the first 8 hex digits of the SHA-256 of the original, so
`github:tilap/site#1` is `github-tilap-site-1-<hash>` and two keys never share a
directory. There is no `%`: a workspace is where the Builder runs the
project's own tools, and several (Vitest among them) refuse a path that looks
URL-encoded. Conductor never uses the raw key as a directory name.

**A declared path is the path.** Every step that needs the workspace reads the
one the WorkLedger declared for it and computes the layout's own only when none
is declared. A unit that starts over destroys what is at that path first, so
its branch is free to be taken again. The Authority is handed the workspace in
`submit` (`workspace`), and works out nothing itself.

It **declares** that path on the WorkLedger, **then** calls `isolate`. After
`markDone`, it deletes the directory and `clearWorkspace`.

## 7. Commands

Each command is a function on the opened conductor. Illegal input returns
`refused` with a `code`. It does not throw for domain reasons. A refused
command does not start a Transformer.

| Command      | Meaning                                                                                                                                                             | Refused when                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `reconcile`  | `expireBail` on expired keys. Destroy directories under `workspaceRoot` that are not on `listDeclaredWorkspaces`. Delete the declared directory of a unit whose lease expired. | Paths not absolute (constructor already threw) |
| `pause`      | In-process flag: no new `claim`, no new unit start, no `markMerging` / final fold into WorkLineStable. Current `implement` / `isolate` / `integrate` may finish | —                                              |
| `resume`     | Clear the pause flag. Does not itself take work                                                                                                                     | —                                              |
| `runProject` | Reconcile, then take or resume the active TicketStandard on that Project, and drive it until a terminal or wait state                                              | `workLineStable` missing on disk               |
| `cancel`     | `ledger.cancel(key)` then destroy declared workspaces for that key                                                                                                  | Ledger `point-of-no-return`                    |
| `release`    | `ledger.releaseBail(key)` then destroy the declared directory when one was recorded                                                                                 | Ledger `illegal-transition` / `not-found`      |

`runProject` outcomes:

| Outcome     | Meaning                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------- |
| `idle`      | No `received` TicketStandard and no active one on that Project                               |
| `done`      | The TicketStandard is `done` in WorkLineStable                                               |
| `escalated` | Frozen for a human. The workspace is kept for inspection                                      |
| `paused`    | Stopped at a pause boundary. Ledger holds the current state                                   |
| `refused`   | Constructor-level or ledger refusal the loop cannot handle (`persist-failed`, missing stable) |

`runProject` does **not** wait for a human `resume`. After `escalated`, the
caller (TicketTracker path) calls `ledger.resumeTicket(key)` then `runProject`
again.

## 8. Happy path (ledger before act)

One TicketStandard, one Project. Pause flag is off.

1. `reconcile`.
2. If the Project already has an active TicketStandard, resume it. Else `claim`.
   Empty → `idle`.
3. **The unit.** When the ledger is `running`, no lease is held and pause is
   off: destroy what is at the workspace path, `declareWorkspace` **then**
   `isolate` (parent = WorkLineStable, child = the workspace). Failure: no
   lease was taken, so `runProject` returns `refused` (`isolate-failed` or
   `transformer-invalid`) and a retry starts the unit again. When a `warm` port
   is configured, prepare the workspace next (install deps, …) — each time the
   workspace is made. Failure: `refused` with `warm-failed` (or `interrupted` /
   `transformer-invalid`). Then `startUnit` (the lease) and `implement` in that
   workspace.
   1. For each Trace, `recordAttempt` with the next number and that Trace's
      `ended`, plus `report` / `refusedBy` when present.
   2. `validated` → `markIntegrating`. The result stays loose in the
      workspace; the Integration in 4.3 takes it up.
   3. `escalated` from Implementer → `escalate({ kind: "unit" })` (Trace
      already recorded). Keep the workspace. `resumeTicket` returns the
      Ticket to `running`, forgets the workspace, and the unit starts again from zero.
   4. After `markIntegrating`, if `pending_fingerprint` is set,
      `escalate({ kind: "unit" })` with a report that says the intention was
      edited in flight and what resume does. The ledger consumes the pending
      field. A newer TicketStandard body lands by `admit` of the corrected
      document (from `escalated` → `received`).
   A `running` Ticket that holds a lease is `paused`: its lease runs out on
   its own when nobody is on it.
4. **The workspace must still be there** from `integrating` on. When it is
   gone, Conductor does not make it again from the work line, which would drop
   what was made: it escalates `kind: "submitted"` when the Authority holds a
   Submission, `kind: "assembly"` otherwise.
5. Pause is honoured before the unit starts, after Isolation, before align and
   before `markMerging`.
6. When the ledger is `integrating` and pause is off:
   1. If `pending_fingerprint` is set, escalate `kind: "unit"` as in 3.4 and
      stop. Do not align.
   2. If a parked refusal or a Submission `last_report` is set (the parked one
      wins when both are), `implement` on the ticket workspace with
      `stage: "ticket"`, `produce: true`, and that report **before** align.
      `escalated` → `escalate({ kind: "assembly" })`.
   3. **Align.** `integrate` with WorkLineStable as **child** and the
      workspace as **parent**. What is loose in the workspace is first taken up
      as one commit whose subject is the Ticket's title (or its intention's
      headline); after a refusal it is the repair, with its own subject. `conflict` → the work is **sent back** like any
      refusal (see below), with a report that names the line and says what to do;
      it is not a stop. Do not `escalate({ kind: "merging" })` here: that would set
      `born_in_merging` and block cancel before WorkLineStable is the fold parent.
   3b. **Recheck.** Aligning brought other tickets' code in, so the unit's own
      Gates run again: `implement` on the ticket workspace with
      `stage: "ticket"`, `produce: false`, `recheck: true` (one attempt; Host
      judges it by `ticket.build.gates`, no other list). `validated` →
      `clearParkedRefusal`. `escalated` → sent back with the Gate's report and name.

   **Sent back** (align conflict, failed recheck, `ticket.validate` refusal): with
   `fixDeclared`, a retryable cause and budget left → `recordParkedRefusal`,
   return `paused`; the next pass produces the fix, then aligns, rechecks and
   validates again. Otherwise (blocking, budget spent, no fix declared) →
   `escalate({ kind: "assembly" })`. **One budget** covers every loop of a ticket:
   `submission.refusals + parked_refusals + submission.realigns`, against
   `maxRefusals`.
   4. **Validate**, when `validate` is set — with or without an
      Authority. `implement` on the ticket workspace with `stage: "ticket"`
      and `validate: true` (no gates, one attempt). `validated` →
      `clearParkedRefusal`, then continue to 5 or 6. `escalated`, retryable,
      under `maxRefusals` (the budget shared with `submission.refusals`), and
      `fixDeclared` → `recordParkedRefusal`, return `paused`. Do not
      continue to 5 or 6. `escalated` otherwise (blocking, at the budget, or no
      `ticket.fix` declared) → `escalate({ kind: "assembly" })`.
   5. **Without an Authority.** `implement` on the ticket workspace with
      `stage: "ticket"` and `produce: false` (judgement only). `validated` →
      `markMerging`. `escalated` → `escalate({ kind: "assembly" })`.
      Then **final fold**: `integrate` ticket child into WorkLineStable.
      `integrated` → `markDone`, delete ticket directory, `clearWorkspace`.
      `conflict` → `escalate({ kind: "merging" })`, keep the ticket directory.
   6. **With an Authority.** `submit` the assembled ticket. `submitted` →
      `markSubmitted`, return `paused`. `refused` → `escalate({ kind: "submitted" })`
      with the refusal's reason as its report — the Publisher's or the
      Authority's own words, the only record of why the offer failed.
      `unavailable` → return `paused` (retry later). On a later `runProject` in
      `submitted`: judge with `produce: false`. Blocking or over `maxRefusals` →
      `escalate({ kind: "submitted" })`. Retryable refusal → `recordRefusal`
      (which also drops a stale parked refusal, if one is held),
      return `paused` (next pass repairs then aligns, then offers again).
      `validated` → ask the Authority whether the line moved on (`behind`, when
      it can say): `unavailable` → `paused`; `behind` → `recordRealign` (state
      `integrating`, no report kept, no fix owed) and `paused`, so the next pass
      aligns, rechecks, validates, offers again and judges again; with the budget spent →
      `escalate({ kind: "submitted" })`; `current`, or no `behind` → Authority
      `fold`. `folded` → `markMerging` then `markDone` (with the fold's `reference`, when the Authority named one)
      (the Authority moved the work line; Conductor does not `integrate` into
      WorkLineStable). `conflict` → the same as `behind`: `recordRealign` and back to align
      (the alignment conflicts, the fix is told); `escalate({ kind: "submitted" })` only
      when the budget is spent.

## 9. Pause and interrupt

Pause is an in-process flag on the opened conductor. It is not stored in the
WorkLedger (pause is Conductor admission, not a TicketStandard state).

Boundaries where pause is honoured: before `claim`, before the unit starts,
before align, before `markMerging`. A running `implement` finishes.

Interrupt is the Transformer Port's problem (the same `interruptFlag` the Transformers
already take). If `implement` returns `interrupted` once the lease is taken,
Conductor does not mark the unit done. It calls `releaseBail` — the Attempt
is spent, the declared directory is destroyed — and returns `refused` with
code `interrupted`. The next process starts the unit again without waiting for
the bail clock. Interrupt during Isolation, warm, align, assembly, or a
Submission judgement leaves the ledger as the last successful command left it:
those paths resume on the next `runProject` without a held lease.

## 10. Reconcile

After process start, and at the beginning of every `runProject`:

1. `listDeclaredWorkspaces`.
2. Delete any directory under `workspaceRoot` whose absolute path is **not**
   on that list (orphans). Never delete `workLineStable`.
3. `expireBail` for those declared keys, and for `activeOn(project)` when that
   TicketStandard's bail is past expiry. Then delete the unit's directory if
   the ledger cleared it.

The ledger decides Ticket state. Disk never does. Conductor does not scan
every Project; `runProject` reconciles the workspaces on disk plus the Project
it was asked to run.

## 11. Refusals

| Code                  | When                                                             |
| --------------------- | ---------------------------------------------------------------- |
| `stable-missing`      | `workLineStable` is not a directory                              |
| `root-invalid`        | `workspaceRoot` is not absolute, or equals `workLineStable`      |
| `persist-failed`      | A ledger command returned `persist-failed`                       |
| `interrupted`         | A transformer returned `interrupted`                             |
| `isolate-failed`      | Isolation did not return `isolated`                              |
| `warm-failed`         | Warm (when configured) did not return `warmed`                   |
| `transformer-invalid` | A transformer returned `invalid-invocation`                      |

Ledger codes (`project-busy`, `point-of-no-return`, …) pass through on `cancel`
and when `claim` refuses.

## 12. What is implemented

Shipped:

- Import face, `openConductor({ ledger, transformers, workLineStable, workspaceRoot })`
- Optional Authority (`submit` / `fold`), `workLineTarget`, `maxRefusals`
- Optional local `validate`, before offer or the local judge, with or
  without an Authority. Its refusal is parked on the aggregate and shares the
  `maxRefusals` budget; `fixDeclared` says whether it escalates on the
  spot instead
- `reconcile`, `pause`, `resume`, `runProject`, `cancel`, `release`
- Happy path: align, assembly judgement (`produce: false`), `markMerging`, final fold
- Authority path: offer, judge, `recordRefusal` / fold, no Integrator fold into WorkLineStable
- `pending_fingerprint` consumed when the unit ends and when entering `integrating`
- Ledger-before-act, declared workspaces, orphan destroy
- Isolation tests in §4
- Pause boundaries

Not shipped:

- Listener / Adapter / Emitter (the caller wires them
  through a manager package; Host's suite is the first such assembly)
- CLI
- Persistent pause across processes
- A human `resume` daemon (caller invokes `resumeTicket` then `runProject`)
- SQLite, a second workspace layout
- Consuming `pending_fingerprint` while the Ticket is `submitted` (admit stores
  it; the next unit end / integrating entry is what consumes it)

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

1. `runProject` on a Project with one `received` TicketStandard calls `claim`
   then `isolate` then `implement`, and the workspace path is declared **before**
   `isolate`.
2. Fake transformers, all `validated` / `integrated`, no Authority: Ticket ends
   `done`; `isolate` was called once; `integrate` was called twice (align, final
   fold); `implement` ran twice — the unit, then the assembly judgement with
   `produce: false`.
3. A failed Isolation → `refused` (`isolate-failed`); no lease, no Attempt, no
   `implement`.
4. `implement` `escalated` after Traces → each Trace is `recordAttempt`d;
   then `escalate({ kind: "unit" })`; no `integrate`; the directory is not
   deleted by Conductor. After `resumeTicket` the unit starts from a fresh
   workspace.
4b. `implement` `interrupted` (the process was stopped) → the Attempts that
   finished are `recordAttempt`d (the interrupted one is not an Attempt), then
   `releaseBail`: no Attempt is spent, the workspace stays declared and on disk.
   The next pass over the Ticket finds a declared workspace that still holds
   something and picks it up: no `isolate`, no second `warm`; the stage made
   before the producer (the tests) is not made again when the ledger says it is
   done; `implement` is given `firstAttempt` (the Attempts already recorded this
   round, plus one) and, as `report`, the refusal of the last Attempt, or a
   note that the pass before was stopped and left its work there. A declared
   workspace that is gone or empty starts the unit from zero. `release` is the
   way to start over: it drops the bail, destroys the directory and forgets it.
   Conductor does not look inside the workspace, nor at the line it was cut
   from: a Project that cannot pick up a stale one uses `release`.
5. `cancel` of a `running` Ticket → ledger `cancelled`; declared directories
   destroyed. `cancel` after `markMerging` → ledger `point-of-no-return`;
   WorkLineStable untouched.
6. A directory under `workspaceRoot` that is not declared is gone after
   `reconcile`. `workLineStable` is never deleted.
7. `pause` after Isolation, before the unit starts → outcome `paused`; no
   `implement`.
8. `implement` `interrupted` → lease released, directory destroyed, `refused`
   (`interrupted`).
9. A workspace that is gone while the Authority holds a Submission → escalated
   `kind: "submitted"`, and no second Isolation.
10. `src/run/` has no import of `@bluewombat/isolator`, `@bluewombat/implementer`,
    or `@bluewombat/integrator`.
11. Opening Conductor with a Transformer Port test double and a WorkLedger test
    double still passes 1–9. No Transformer `dist/` and no filesystem persist are
    required for those.

An align `conflict` is not a stop: it is sent back to the fix like a refusal
(`recordParkedRefusal`), so no ledger kind is needed for it. Assembly `escalated` uses `escalate({ kind: "assembly" })`;
`resumeTicket` returns that Ticket to `integrating`; a `unit` escalation returns
it to `running`.

## 15. Choices

1. **Not a Transformer.** Sequencing many verbs is not Implementer-shaped.
2. **Injected Transformer Port.** Depending on three Transformer packages would make the
   run loop untestable without `dist/` and would freeze Isolation strategy
   inside Conductor. The caller wires Transformers.
3. **Injected WorkLedger.** Conductor does not open persist. Glue already chose
   the adapter.
4. **Ledger before act, always.** Directories that exist without a declaration
   are orphans and die.
5. **No Emitter in this package.** Reporting is Emitter. Conductor
   returns a result; the caller reports.
6. **Pause is in-process.** A TicketStandard state for pause would confuse
   `escalated` and `resume`. Restart clears pause; reconcile + bail remain.
7. **Stack: TypeScript on Node.js 24.20, Biome, `node:test` run through `tsx`.**
   Same as WorkLedger. Recorded here; commands live in this package's README.

How this package is built and run: [README.md](./README.md).
