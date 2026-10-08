# WorkLedger

Kernel package, not a Transformer. It has many operations, not one IN and one
OUT. Its code, identifiers, comments, and messages name only what it owns:
Feature records, Plans, Attempts, Traces, states, bails, and the Persistence
Port. No Transformer is named inside that perimeter, because none of them exist
there.

WorkLedger is the durable store of FeatureStandards, Subtasks, states, Attempts,
and Traces. It is the system's source of truth. Glue writes here **before** it
acts. Isolated workspaces are a consequence of that state, never the source of
it.

WorkLedger does not isolate a directory, run a Builder, fold a Child, or report
to a FeatureManager. It accepts an already-normalized FeatureStandard (or an
`invalid` verdict). It does not convert raw intentions.

Callers inject a persistence adapter. Adapters are their own packages under
`packages/` (`persist-fs`, `persist-sqlite`, later `persist-postgres`).
The domain never imports an adapter; an adapter never imports the ledger.

## 1. Job

```
  caller                         WorkLedger                       adapter
  ------                         ----------                       -------
  command or query               check, transition, persist       load / save / list
  Persistence Port (injected)
                             ←   record, or refused + code
```

**In:** a command or a query, plus an injected Persistence Port. **Out:** a
typed result. No JSON lines, no exit code, no Status protocol. Those belong to
Transformers. This package is a function set imported in process.

There is no required CLI. If a CLI appears later, it is a thin adapter over the
same functions, the way a Transformer's `cli.ts` is.

## 2. Faces and wiring

| Face    | Entry                                              | Must not                              |
| ------- | -------------------------------------------------- | ------------------------------------- |
| Import  | `openWorkLedger({ persist })` then command methods | Read `process.env` to pick an adapter |
| Adapter | A value that implements the Persistence Port       | Live under `src/ledger/` or in this package |

Glue builds the adapter (`openFilesystemPersist({ root })` from
`@bluewombat/persist-fs`, `openSqlitePersist({ path })` from
`@bluewombat/persist-sqlite`) and passes it in. The ledger does not sniff the
environment, the working directory, or a file extension to choose a backend.
It never names a concrete adapter.

Transformers do not import this package. Conductor does. Host chooses the adapter.

## 3. Two layers

```
  commands / queries          src/ledger/          FeatureStandard states, Plan freeze,
                                                   bail, Attempt, Trace, refusals
           │
           │  Persistence Port (plain records)
           ▼
  adapters                    packages/plugins/persist-<name>/  bytes on disk, rows in a database
```

| Layer   | Owns                                                                                       | Does not own                                   |
| ------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| Ledger  | Legal transitions, idempotence, bound counters, bail                                       | `node:fs`, `sqlite`, `pg`, paths               |
| Port    | The record shapes that cross the boundary, and the verbs `load` / `save` / `listSummaries` | FeatureStandard state names as a state machine |
| Adapter | How those records are stored and listed                                                    | Whether `merging` may be cancelled             |

A caller never talks to an adapter. It talks to the ledger. The ledger never
talks to `node:fs`. It talks to the Port.

## 4. Adapter isolation

Hard rules. Breaking one is a spec bug, not a refactor.

1. **One package per adapter**, under `packages/plugins/persist-<name>/` (name is
   `fs`, `sqlite`, later `postgres`, …). Nothing of an adapter leaks into
   `src/ledger/` or into a sibling adapter.
2. **`src/ledger/` does not import an adapter package**, `node:fs`, or
   `node:sqlite`. It imports only the Port type (and record types). A test that
   fails if `ledger` grows such an import is part of this contract.
3. **An adapter package does not import `src/ledger/`.** It imports the Port and
   the persisted record types from `@bluewombat/work-ledger`. An adapter that
   needs a transition table has crossed the line.
4. **Shared persisted shapes live in this package** (`src/records.ts`). They are
   data, not behaviour.
5. **No `if (adapter === "sqlite")` in the ledger.** New backends add a package
   and a constructor. They do not edit command code.
6. **Filesystem and SQLite both ship.** Postgres is named so the Port stays
   honest. Its package does not exist until someone implements it.
7. **Domain tests inject a Port.** They use a test double, or an adapter package
   on a temp path. They do not reach into adapter internals. Adapter tests do
   not run FeatureStandard transitions.

## 5. Persistence Port

Three operations. Adapters may store one JSON file or ten SQL tables; the Port
does not care.

| Operation       | In                        | Out                                  |
| --------------- | ------------------------- | ------------------------------------ |
| `load`          | Feature `key`             | Aggregate, or missing                |
| `save`          | Feature `key` + aggregate | Durable replace of that key. Atomic. |
| `listSummaries` | none                      | One summary per known key            |

`save` replaces the whole aggregate for that key. The ledger read-modify-writes.
The adapter does not merge. If `save` cannot complete, it fails; it does not
leave a half-written key that `load` could return.

`listSummaries` exists so `claim` can pick the next `received` FeatureStandard
without loading every Trace. A summary carries at least: `key`, `project`,
`state`, `priority`, `received_at`, bail expiry if any.

An adapter that cannot satisfy atomic `save` is not a WorkLedger adapter.

## 6. Filesystem adapter (`@bluewombat/persist-fs`)

Constructor: `openFilesystemPersist({ root })`. `root` is an absolute directory.
The adapter creates it if missing. This package does not live here.

Physical layout is this adapter's private choice. `persist-fs` uses
one file per key:

```
<root>/<encoded-key>.json
```

`<encoded-key>` is `encodeURIComponent(key)` so a key `fake:42` is one path
segment (`fake%3A42.json`). The adapter never uses the raw key as a filename.

`save` writes a sibling temporary file in `root`, then renames onto the target
(atomic on the same filesystem). A crash during `save` leaves either the old
file or the new file, never a truncated JSON document that parses as a
different aggregate.

This adapter knows directories and JSON. It does not know `merging`, `ready`,
or Isolator.

## 7. Adapter packages

Same Port, own package, own constructor.

| Adapter    | Package                         | Constructor sketch                   |
| ---------- | ------------------------------- | ------------------------------------ |
| Filesystem | `packages/plugins/persist-fs`       | `openFilesystemPersist({ root })`    |
| SQLite     | `packages/plugins/persist-sqlite`   | `openSqlitePersist({ path })`        |
| Postgres   | `packages/work-ledger-postgres` | `openPostgresPersist({ url })`       |

They may split an aggregate into tables. `load` / `save` still look like one
aggregate to the ledger. A Postgres adapter that exposes SQL to glue has leaked
through the Port.

## 8. Aggregate

One aggregate per FeatureStandard `key` (`<manager>:<external_id>`). The Adapter
produced `key` and `fingerprint`; WorkLedger owns everything else.

| Part                | Content                                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Identity            | `key`, `project`, `fingerprint`                                                                                       |
| Intention           | FeatureStandard fields this package stores (intention, title, priority, source, …)                                     |
| Feature state       | Exactly one of §9                                                                                                     |
| Invalid             | `code` + `reason` when state is `invalid`                                                                             |
| Pending fingerprint | Set when an update arrives during `planning` / `running` / `integrating`; applied only after the in-flight work stops |
| Plan                | Absent until freeze. Then frozen: Subtasks, dependencies, `planned_at`. No automatic rewrite                          |
| Subtask states      | Per Subtask, exactly one of §9                                                                                        |
| Attempts            | Numbered, each with a Trace when an Attempt ran, and stamped with the round (`resumes` at the time) it belongs to      |
| Bound counters      | Attempts used, as this package tracks them                                                                            |
| Resumes             | How many `resumeReady` were taken. A round tells two escalations of one kind apart; absent reads as 0                  |
| Parked refusal      | A report `assembly.validate` sent back, held on the aggregate because there may be no Submission yet. Present only while `integrating`; cleared once validate accepts |
| Parked refusals     | How many times `assembly.validate` sent the work back with no Submission's own counter to hold it. Shares the `maxRefusals` budget with `submission.refusals` |
| Bail                | Optional. `expires_at` when a feature or Subtask is claimed                                                                       |
| Declared workspaces | Optional absolute paths glue wrote **before** creating those directories                                              |

Unknown fields from a FeatureStandard that FeatureAdapter would drop are not
invented here either. WorkLedger does not reopen the Adapter's closed shape.

`integrated` Subtasks are never removed from the Plan. An Attempt is never
rewritten; a new Attempt is appended.

## 9. States

FeatureStandard states, copied from the product glossary. WorkLedger is the
component that actually holds them.

| State         | Meaning                                            |
| ------------- | -------------------------------------------------- |
| `received`    | Admitted, not yet claimed                          |
| `invalid`     | Stored as unusable, with a code; not silent        |
| `planning`    | Breakdown in progress (bail held)                  |
| `running`     | Subtask loop (bail held)                           |
| `escalated`   | Frozen for a human                                 |
| `integrating` | All Subtasks `integrated`; assembly Gates          |
| `submitted`   | Offered to an Authority; waiting on its judgement  |
| `merging`     | Final fold into WorkLineStable. Point of no return |
| `done`        | Terminal. In WorkLineStable                        |
| `cancelled`   | Terminal. Abandoned before final integration       |

Subtask states: `pending`, `runnable`, `running`, `escalated`, `integrated`,
`cancelled`.

A command that would require a transition not in this section is `refused`.
The aggregate is unchanged.

## 10. Commands

Each command is a function on the opened ledger. Illegal input or an illegal
transition returns `refused` with a `code`. It does not throw for domain
reasons. It does not persist a refused command.

Idempotence is on `key` unless a row says otherwise.

| Command                 | Meaning                                                                                                                                                                                                       | Refused when                                                                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admit`                 | Store a FeatureStandard in `received`. Same `key` already `received` with the same fingerprint → success, no rewrite. Same `key`, different fingerprint, not in-flight → update the stored intention. Same `key` in-flight (`planning` / `running` / `integrating` / `submitted`) with the same fingerprint (or the fingerprint already pending) → success, no rewrite. A different fingerprint while in-flight is recorded as pending; the live work is not rewritten. | `key` in `merging` or `done`; `key` in `cancelled` |
| `recordInvalid`         | Store `invalid` with code, reason and the fingerprint of what was received                                                                                                                                                                       | `key` already in `merging` or `done`                                                                                                                                |
| `claim`                 | Take the next `received` FeatureStandard for a Project (priority then `received_at`). Hold bail. State → `planning`. No-op with `empty` when none, or when that Project already has an active FeatureStandard | That Project already has `planning`, `running`, `escalated`, `integrating`, `submitted`, or `merging`                                                               |
| `recordPlan`            | Freeze the Plan. Subtasks start `pending` / `runnable`. State → `running`                                                                                                                                     | Not `planning`; Plan already frozen; Plan fails the same structural checks FeatureBreakdown already applied (empty, cycle, missing definition of done, …)           |
| `refusePlan`            | Breakdown refused. State → `escalated` with the Breakdown code                                                                                                                                                | Not `planning`                                                                                                                                                      |
| `startSubtask`          | Named Subtask → `running`. Feature stays `running`. Bail renewed or held                                                                                                                                      | Feature not `running`; Subtask not `runnable`; another Subtask already `running`                                                                                    |
| `recordAttempt`         | Append an Attempt + Trace (`ended`, optional `report` and `refusedBy`)                                                                                                | That Subtask is not `running`; Attempt number not the next integer                                                                                                  |
| `markSubtaskIntegrated` | Subtask → `integrated`. If no Subtask remains non-terminal → Feature → `integrating`                                                                                                                          | Subtask not `running`; Feature not `running`                                                                                                                        |
| `markSubmitted`         | Feature → `submitted`. Records the Authority's opaque `reference`. A second call keeps the first reference and any `last_report`                                      | Not `integrating` or `submitted`                                                                                                                                    |
| `recordRefusal`         | Authority / assembly Gates sent the work back. Increment `refusals`, store `last_report`, Feature → `integrating`. Clears a stale parked refusal, if one is held                                                     | Not `submitted`                                                                                                                                                     |
| `recordParkedRefusal`   | `assembly.validate` sent the work back before any Submission exists. Store the parked report, increment `parked_refusals`                                                                                    | Not `integrating`                                                                                                                                                   |
| `clearParkedRefusal`    | `assembly.validate` accepted. Drop the parked report; the counter stays — it is the budget already spent                                                                                                      | —                                                                                                                                                                   |
| `markMerging`           | Feature → `merging`                                                                                                                                                                                           | Not `integrating` or `submitted`                                                                                                                                    |
| `markDone`              | Feature → `done`. Records the fold's `reference` when given (the work line's own name for it, opaque). Clear bail. Clear declared Subtask workspace                                                                                                                                                | Not `merging`                                                                                                                                                       |
| `escalate`              | Feature → `escalated` (whole feature frozen). Trace required if an Attempt exists for the named Subtask. Consumes `pending_fingerprint`. | Feature already `done` or `cancelled`; escalation without Trace when an Attempt existed                                                                             |
| `resumeReady`           | Human `ready`. Plan escalation → `planning` (Plan unfrozen, Breakdown replayed). Subtask escalation → that Subtask `runnable` from zero, Feature `running`. Escalation from `merging`, `submitted`, or `assembly` → `integrating`         | Not `escalated` or `invalid`; `invalid` without a new admissible FeatureStandard                                                                                    |
| `cancel`                | Feature → `cancelled`. Remaining Subtasks `cancelled`. `integrated` Subtasks stay `integrated`                                                                                                                | `merging` or `done`; an escalation that was born in `merging`                                                                                                       |
| `declareWorkspace`      | Record a WorkSpaceFeature and/or WorkSpaceSubtask path **before** glue creates it                                                                                                                             | Feature `done` or `cancelled`                                                                                                                                       |
| `clearWorkspace`        | Drop a declared path after glue deleted that directory                                                                                                                                                        | —                                                                                                                                                                   |
| `expireBail`            | Bail past expiry: Subtask `running` → `runnable` (from zero, consume an Attempt); Feature `planning` → `received`                                                                                             | No bail, or bail not expired                                                                                                                                        |
| `releaseBail`           | Same ledger outcome as an expired bail in `planning` / `running`, without waiting for the clock. A `running` Feature with no Subtask held is success with no rewrite                                           | Feature not `planning` or `running`                                                                                                                                 |
| `renewBail`             | Push bail expiry forward by the configured duration. Allowed while a bail is held                                                                                                                             | No bail                                                                                                                                                             |

`resumeReady` from `invalid` requires `admit` of a corrected FeatureStandard
first (`invalid` → `received` is `admit` after correction, then claim).

In-flight update (`admit` while `planning` / `running` / `integrating` /
`submitted`): same fingerprint as the live intention, or as the fingerprint
already pending → success, no rewrite (an echo of a report). A different
fingerprint is stored as pending; do not change the frozen Plan; do not
rewrite the live intention. `escalate` consumes `pending_fingerprint`.
Conductor calls `escalate({ kind: "plan" })` after a Subtask is marked
integrated, and when entering `integrating`, if the field is set. WorkLedger
does not watch a Transformer's clock.

Escalation `kind` is one of `plan`, `subtask`, `assembly`, `submitted`,
`merging`.

## 11. Queries

| Query                    | Out                                                                                                                                    |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `get`                    | Aggregate for a `key`, or missing                                                                                                      |
| `list`                   | One summary per known key, every state. No persist, no bail, no transition                                                             |
| `listInFlight`           | The `list` subset that is mid-flight (`planning` / `running` / `integrating` / `submitted`)                                            |
| `activeOn`               | The active FeatureStandard on a Project (`planning` / `running` / `escalated` / `integrating` / `submitted` / `merging`), or none |
| `nextReceived`           | What `claim` would take, without taking it                                                                                             |
| `nextRunnable`           | A `runnable` Subtask of a Feature (ties: the one that unblocks the most others). Glue still serializes                                 |
| `listDeclaredWorkspaces` | Keys and paths the ledger believes exist. Glue reconciles disk to this list. Orphans on disk that are not listed are glue's to destroy |

Queries do not persist. They do not take a bail.

## 12. Bail and reconcile

While a FeatureStandard is `planning`, `running`, `integrating`, `submitted`,
or `merging`, it holds a bail (`expires_at`). There is no holder id in this
implementation. Glue renews by calling `startSubtask` / `claim`-family
commands; `renewBail` exists if expiry would otherwise pass during a long
Attempt.

Expired bail: `expireBail`. The Subtask becomes `runnable` from zero and
consumes an Attempt. Declared Subtask workspace is cleared (glue deletes the
directory). The ledger decides; glue acts.

A clean stop (or an operator) that knows the holder is gone calls
`releaseBail`: the same `planning` / `running` outcome, without the clock.
It refuses `integrating`, `submitted`, `merging`, and every terminal state —
those are not a held Subtask. A `running` Feature that already has no Subtask
`running` is success with no rewrite.

After a process start, glue calls `listDeclaredWorkspaces` and destroys
directories that are not on that list. It does not invent Feature state from
disk.

## 13. Refusals

A refused command leaves the store as it was. `code` is one token.

| Code                   | When                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| `not-found`            | `key` is unknown                                                                                   |
| `duplicate`            | Reserved; `admit` of an identical fingerprint is success, not this                                 |
| `illegal-transition`   | State does not allow this command                                                                  |
| `project-busy`         | `claim` while that Project already has an active FeatureStandard                                   |
| `plan-frozen`          | `recordPlan` when a Plan already exists                                                            |
| `plan-not-frozen`      | A Subtask command before `recordPlan`                                                              |
| `subtask-not-runnable` | `startSubtask` on a Subtask whose dependencies are not `integrated`                                |
| `another-running`      | `startSubtask` while one Subtask is already `running`                                              |
| `missing-trace`        | `escalate` after an Attempt with no Trace                                                          |
| `point-of-no-return`   | `cancel` in `merging` or `done`, or abandon after merging-born escalation                          |
| `too-late`             | `admit` / `recordInvalid` / intention edit in `done`                                               |
| `persist-failed`       | Adapter `save` failed. Aggregate in memory is not the source of truth; caller retries or escalates |

`persist-failed` is the only refusal that may mean "we do not know if bytes
landed". Glue treats it as unavailable, not as `invalid`.

## 14. What is implemented

Shipped:

- Import face, `openWorkLedger({ persist })`
- Filesystem adapter (`packages/plugins/persist-fs`)
- SQLite adapter (`packages/plugins/persist-sqlite`)
- Commands and queries in §10–§11
- Isolation tests in §4

Not shipped:

- Postgres adapter
- CLI
- A human UI
- Pause / emergency-stop flags (Conductor admission, not this store)

## 15. Layout

```
SPECS.md                 this contract
README.md                how to build and run
src/
  index.ts               openWorkLedger; re-export commands, records, Port
  records.ts             persisted shapes (no behaviour)
  persist/
    port.ts              Persistence Port only
  ledger/                commands, queries, transitions; imports Port, not an adapter
```

Adapters are sibling packages under `packages/plugins/persist-<name>/`, not
directories here.

## 16. Acceptance

1. `admit` of a new FeatureStandard → `get` returns it in `received` with that
   `key` and `fingerprint`.
2. `admit` of the same `key` and fingerprint again → success, aggregate
   unchanged (byte-for-byte on the stored fingerprint and intention).
3. `admit` of the same `key` with a new fingerprint while `received` → stored
   intention updates.
4. `admit` while `running` with a new fingerprint → pending fingerprint set;
   frozen Plan unchanged; Feature state still `running`. Same fingerprint
   while `running` or `submitted` → success, no pending field.
5. `claim` on a Project with one `received` → that Feature is `planning` and
   holds a bail. A second `claim` on the same Project → `project-busy`.
6. `recordPlan` with two Subtasks, B depending on A → A `runnable`, B
   `pending`. `startSubtask(B)` → `subtask-not-runnable`.
7. `startSubtask(A)` then `startSubtask` on any other → `another-running`.
8. `markSubtaskIntegrated` on the last non-terminal Subtask → Feature
   `integrating`.
9. `cancel` in `merging` → `point-of-no-return`; state still `merging`.
10. `escalate` after `recordAttempt` without a Trace → `missing-trace`; state
    unchanged.
11. `declareWorkspace` then `listDeclaredWorkspaces` includes that path.
    `clearWorkspace` removes it.
12. `save` via the filesystem adapter: after a successful `admit`, the file
    `<root>/<encoded-key>.json` exists and `load` round-trips the aggregate.
13. Filesystem `save` is atomic: a reader never observes truncated JSON.
14. `src/ledger/` has no import of an adapter package, `node:fs`, or `node:sqlite`.
15. `src/persist/` holds only `port.ts`.
16. Opening the ledger with a different Persistence Port (a test double) still
    passes 1–11. No filesystem is required for those.
17. SQLite `save` then `load` round-trips the same aggregate.

## 17. Choices

Decisions taken while writing this spec. Each one is a choice, not a
consequence: another answer was possible.

1. **Not a Transformer.** A store with many verbs is not IN/OUT-shaped. One IN
   and one OUT would force a toolbox CLI and hide the transition table.
2. **Commands, not `set(state)`.** The product rules (plan freeze, one active
   FeatureStandard per Project, no abandon in `merging`) live here or they live
   nowhere.
3. **Injected Persistence Port.** Sniffing env or a path to pick SQLite later
   would couple the ledger to ops. Glue chooses; the ledger stays portable.
4. **Adapters are sibling packages.** A directory inside this package would mix
   kernel with a file format. Separate packages make a SQLite backend a new
   `packages/` directory, not an edit of command code.
5. **Port is load / save / listSummaries of one aggregate.** Fine-grained row
   verbs would leak SQL into the ledger. Adapters may split storage internally.
6. **Filesystem and SQLite both ship.** Enough to be truth on disk or in one
   file. Postgres is an adapter, not a prerequisite.
7. **Keys encoded for filenames.** FeatureAdapter keys contain `:`. Using them
   raw would create extra directories or illegal paths.
8. **Refused commands do not persist.** A failed transition must not look like
   history.
9. **`persist-failed` is not `invalid`.** Disk or database blips must not brand
   a FeatureStandard unusable.
10. **Declared workspaces are ledger facts, not discoveries.** Glue writes the
    path before creating the directory, so crash reconcile has a list that
    disk cannot lie about.
11. **No CLI.** The caller is TypeScript glue. A
    CLI can wait; two faces would be invented before a second caller exists.
12. **Stack: TypeScript on Node.js 24, Biome, `node:test` run through `tsx`.**
    Recorded here as a decision; the commands live in this package's README
    when it exists.

How this package is built and run: [README.md](./README.md).
