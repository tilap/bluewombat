# runtime

Host: the process you run, `@bluewombat/runtime`, binary `mason`. It listens,
admits, calls Conductor, and reports. It does not know a tracker: it loads one
FeatureManager package and hands it the options it never reads. Contract:
[SPECS.md](./SPECS.md).

## Install

```bash
npm install @bluewombat/runtime @bluewombat/manager-github @bluewombat/slots
npx mason init
```

`init` at a terminal asks its way through: which manager (only when more than
one is installed), what that manager needs, and where WorkLineStable is — it can
clone it, and refuses a branch the remote does not have. Then it writes the
files and runs `setup` itself, offering to apply what the tracker is missing.
The Builder is left for you.

```bash
npx mason doctor
npx mason run
npx mason watch
```

A script gets the same result with no questions — `--manager` turns them off:

```bash
mason init --manager @bluewombat/manager-github \
  --manager-option repo=owner/name \
  --manager-option labels=mason \
  --work-line-stable ./work-line-stable \
  --clone git@github.com:owner/name.git --branch dev
mason setup --apply
mason doctor
mason run
```

Each `--manager-option` is read by the question that would have asked for it, so
a malformed one stops `init` before it writes. `--clone` does what the wizard
offers: it checks the branch is really on the remote before cloning, falls back
to the remote's own default branch when `--branch` is left out, and leaves an
existing directory alone. `--interactive` forces the questions back on when
stdin is a pipe. `doctor` is the command whose exit code says whether a run will
work.

A GitHub Issues tracker is `@bluewombat/manager-github`, configured in that
package's README — Host does not grow a `--repo` flag for it.

## Commands

| Command         | Job                                                                                    |
| --------------- | -------------------------------------------------------------------------------------- |
| `mason run`     | Drain the FeatureManager, run Conductor, report                                        |
| `mason watch`   | Snapshot the ledger and follow the journal. Ctrl-C leaves the worker running           |
| `mason status`  | Snapshot the ledger, then exit. `--json` for scripts                                   |
| `mason log`     | Replay the journal, with the reason a phase stopped. `--problems` for just those       |
| `mason init`    | Set this directory up: asks, writes the config and the Builder stub, then runs `setup` |
| `mason setup`   | Prepare the tracker. A plan by default; `--apply` writes. Exit 1 on a blocked step     |
| `mason doctor`  | Check the config, the slots, and the manager. Exit 1 on any failure                    |
| `mason cancel`  | Abandon a Feature by key, when the tracker cannot say it is gone                       |
| `mason release` | Drop a held Subtask without waiting for the bail clock                                 |

One `run` per ledger: `run` writes `<ledger>/lock` with its pid and a second
`run` on the same home refuses to start while that process lives (two runs
both listen, both drive, and the tracker hears everything twice). A lock a
dead process left behind is taken over.

`setup` is the only command that changes anything outside this machine, and only
with `--apply`. What it prepares is the manager's business — Host prints the
steps it is handed. A manager without `setupManager` says it has nothing to do.

`init` takes `--manager NAME` (which turns the questions off), `--manager-option KEY=VALUE`,
`--work-line-stable DIR`, `--clone REMOTE`, `--branch NAME`, `--force` and `--interactive`.

Leave `mason run` going in one terminal. In another:

```bash
mason watch
```

That is the operator surface: the durable state of every Feature, then the film
of the current step (`submitted` included). It does not talk to the tracker, and
it cannot `ready` or claim. `status` is the same snapshot without the
follow. `--json` prints that snapshot as JSON.

When a run only printed `unavailable:<key>`, the reason is already in the
journal and `log` is how you read it:

```bash
mason log --problems
```

`--all` keeps the idle polls. `--tail N` limits the text film (`0` shows every
kept line). `--json` prints every kept line; with `--tail`, a truncated reply
names how many were kept and how many are shown. The closing tally counts each
distinct failure. A pause with no planner exit code is counted apart from a
non-zero exit. If a slot was started with `--transcript-dir`, the newest
transcript files are named underneath, with the agent exit and duration read
from the start of each file.

To abandon a Feature the tracker can no longer mention (a deleted issue, a
manager with no `probe`), stop `run` if it holds the ledger lock, then:

```bash
mason cancel github:owner/name#19
```

After a crash left a Subtask `running` with nobody on it, stop `run` if it
holds the lock, then:

```bash
mason release github:owner/name#19
```

The film is `<ledger>/events.jsonl`, next to `cursor`. It is not truth after a
crash — the ledger is. The file can grow; there is no rotation yet.

## Config

`mason.config.yaml`, found by walking up from the working directory. `--config
FILE` names another one. Relative paths resolve against the file; relative
flag paths resolve against the working directory. Flags override the file, and
`--manager-option` overrides one manager option without dropping the others.
Parsed with the `yaml` package (YAML 1.2 core schema), so a repeated key is
refused rather than silently keeping the last one, and `no` / `on` / `off`
stay plain strings — never coerced to a boolean the way YAML 1.1 would. A
value that starts with `@`, like every `@bluewombat/...` package name, needs
quotes: `@` is a reserved YAML indicator at the start of a plain scalar.

```yaml
manager: "@bluewombat/manager-fake"
managerOptions:
  source: ./.mason/source
  target: ./.mason/threads
workLine:
  stable: ./work-line-stable
  isolation: "@bluewombat/isolation-copy"
  warm:
    cmd: [pnpm, install, --frozen-lockfile]
    timeoutMs: 600000
planner:
  cmd:
    - node
    - ./node_modules/@bluewombat/slots/planners/one-subtask.mjs
  timeoutMs: 600000
builder:
  producer:
    cmd: [node, ./mason-builder.mjs]
    timeoutMs: 600000
  repair:
    cmd: [node, ./mason-repair.mjs]
    timeoutMs: 600000
  maxAttempts: 3
  gates: { defaultTimeoutMs: 120000, gates: [] }
assembly:
  gates: { defaultTimeoutMs: 900000, gates: [] }
authority:
  enabled: false
timeoutMs: 600000
pollIntervalMs: 10000
```

| Field                       | Meaning                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manager`                   | Package name or path that exports `createManager`                                                                                                                                                                                                                                                                                                                            |
| `managerOptions`            | Opaque to Host. What it holds is the manager's own documentation                                                                                                                                                                                                                                                                                                             |
| `workLine.stable`           | Existing directory the work folds into. Optional when the manager names a reference work line: Host then keeps its own copy at `<home>/work-line`                                                                                                                                                                                                                            |
| `workLine.isolation`        | Package name or path exporting `strategy` — required. Host loads it like a manager; Isolator/Integrator do not sniff                                                                                                                                                                                                                                                         |
| `workLine.isolationOptions` | What that strategy is told, unread by Host — like `managerOptions`. `isolation-git` reads `exclude`, the paths a Child never gets (default `.env`, `.env.*`). A strategy without `createStrategy` refuses any                                                                                                                                                                |
| `workLine.warm`             | Optional `cmd` / `timeoutMs`. Runs once in the Feature workspace after Isolation, before any Subtask is copied from it — typically `pnpm install --frozen-lockfile`. Absent: Subtasks inherit a cold Feature                                                                                                                                                                 |
| `workLine.branch`           | The work line a fold lands on. Without it, what the reference names, or else whatever is checked out                                                                                                                                                                                                                                                                         |
| `authority`                 | `enabled`, the `publish` / `refresh` slots, and the optional `describe` slot (§ Describer). Absent: the fold is local                                                                                                                                                                                                                                                        |
| `home`                      | Where Host keeps what is its own — default `./.mason`                                                                                                                                                                                                                                                                                                                        |
| `workspaceRoot`             | Isolated feature / Subtask directories (created). Default `<home>/workspaces`                                                                                                                                                                                                                                                                                                |
| `ledger`                    | WorkLedger root (created). The Cursor is a file inside it. Default `<home>/ledger`                                                                                                                                                                                                                                                                                           |
| `persist`                   | Package name or path exporting `openPersist({ ledgerRoot })`: how the ledger is stored under that root. Default `@bluewombat/persist-fs`; `@bluewombat/persist-sqlite` ships too. `watch` reads through the same backend                                                                                                                                                     |
| `planner`                   | `cmd` / `timeoutMs`. FeatureStandard in, a Plan out                                                                                                                                                                                                                                                                                                                          |
| `builder.producer`          | `cmd` / `timeoutMs`. Spawned in the Subtask workspace. Exit 0 lets Gates run                                                                                                                                                                                                                                                                                                 |
| `builder.repair`            | The same, for a pass a Gate refused. **Required**, and never inherited                                                                                                                                                                                                                                                                                                       |
| `builder.maxAttempts`       | Attempts one Task may start. Default 3                                                                                                                                                                                                                                                                                                                                       |
| `builder.gates`             | `defaultTimeoutMs` and `gates`: ordered checks on each Subtask                                                                                                                                                                                                                                                                                                               |
| `assembly.fix`              | `cmd` / `timeoutMs`. Spawned when a judgement of the whole refused it — by an Authority, by `assembly.validate`, or by both                                                                                                                                                                                                                                                  |
| `assembly.validate`         | `cmd` / `timeoutMs`. Optional. A local, read-only judge of the assembled feature, run after align, with or without an Authority. A refusal is repaired by `assembly.fix` the same as an Authority's                                                                                                                                                                          |
| `assembly.maxAttempts`      | Attempts that one fix may start. Default 3                                                                                                                                                                                                                                                                                                                                   |
| `assembly.gates`            | Ordered checks on the assembled feature. Empty: the Authority judges alone                                                                                                                                                                                                                                                                                                   |
| `timeoutMs`                 | How long a child **outside** a Task may run: manager, isolations                                                                                                                                                                                                                                                                                                             |
| `maxRefusals`               | Times the work may be sent back before it escalates, by an Authority, by `assembly.validate`, or by both — one shared budget. Default 3                                                                                                                                                                                                                                      |
| `pollIntervalMs`            | Set it and the process keeps draining until SIGINT. Absent: one tick. Pick it with § Choosing `pollIntervalMs` — 10000 is the floor worth having                                                                                                                                                                                                                             |
| `observability.streams`     | `enabled`, `dir`, `keep`. Films what every child says, as it says it — one file per child under `<dir>/<feature>/`, named in the journal by a `stream-opened` line. `dir` resolves against the config file; default `<home>/streams`. `keep` is `stdout` / `stderr`, default both. Off unless `enabled` is true: a stream is the Project's own code and prompts in the clear |

Every `cmd` is named where it is used, and nothing falls back to a neighbour: a
`repair` with no command of its own is refused rather than quietly running the
first-pass agent again. `builder` makes a Subtask. `assembly` judges the whole
and, when that judgement refuses it, runs `assembly.fix` — not a second first-pass.
`assembly.validate`, when declared, is a second, local judge of the whole: it
runs after align, before the Authority sees the work (or before the final
fold, with none). Its refusal is repaired by `assembly.fix` exactly as an
Authority's is, and shares the same `maxRefusals` budget.

Every tracker field lives in `managerOptions`. Host does not read them.

### Choosing `pollIntervalMs`

The sleep between two ticks, and nothing else. While a tick drives work — a
Planner, a Builder, a validate — it runs to the end; the interval does not
touch it. It only sets how long `mason run` takes to notice:

- a new issue, or an edit to one;
- that a Submission is ready to be judged: Host does not judge in the tick
  that submitted (`docs/DECISIONS.md`, the Authority re-drive row), so on a
  work line without CI the whole interval is waited for a Gate that answers in
  two seconds;
- a `ready`, or an issue closed to cancel.

**What one tick costs**, with `@bluewombat/manager-github` (read in
`src/loop/tick.ts` `runOnce`, `src/loop/probe.ts` `abandonGone`, the manager's
`listen`). The manager reads conditionally (its README, § Talking to GitHub):
a read whose answer did not change comes back 304, which does not count
against the token's budget.

| The tick              | GitHub REST calls                                                                                | Counted when nothing moved                                 | Besides                                        |
| --------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- | ---------------------------------------------- |
| Nothing to do         | 1: the issues updated since the Cursor, 100 per page                                             | 0 (304)                                                    | none: no fetch                                 |
| A Feature in flight   | + 1 per Feature that can still be abandoned: is its issue still there                            | 0 (304)                                                    | a `git fetch` of the work line copy (not REST) |
| A Feature `submitted` | + the judgement: `ci-green` asks for the pull request, its check runs and its statuses (about 3) | about 3: `ci-green` is its own process and keeps no `etag` |                                                |

Reports to the tracker (a comment, a label move: 2 to 4 calls each) happen
when the work moves, not per tick, and each changes the listing: the read
after a report is a full one.

**The budget.** A personal access token has 5,000 REST calls an hour
(GitHub's primary rate limit). It is shared by every caller using that token:
the reports, `ci-green`, `gh`, and every other Mason home pointed at it.

| `pollIntervalMs` | Idle, nothing moved | A Feature `submitted` (about 3 counted a tick) | Worst case, every read changed (about 5) |
| ---------------- | ------------------- | ---------------------------------------------- | ---------------------------------------- |
| 30000            | ~0 /h               | 360 /h (7 %)                                   | 600 /h (12 %)                            |
| 15000            | ~0 /h               | 720 /h (14 %)                                  | 1,200 /h (24 %)                          |
| **10000**        | **~0 /h**           | **1,080 /h (22 %)**                            | **1,800 /h (36 %)**                      |
| 5000             | ~0 /h               | 2,160 /h (43 %)                                | 3,600 /h (72 %): too close               |

Measured idle: about 12 ticks at 10 s cost one counted call, the first full
listing. Without conditional reads an idle tick counted one call (360 /h at
10 s).

**The floor.** An idle tick takes 1 to 1.5 s, almost all of it the `listen`
call (measured on `tilap/orangemonkey-site`, October 2026). Below 2 to 3 s
the loop never sleeps. Below 10 s nothing a person notices is gained: a
Feature takes minutes, and 10 s against 30 s saves about 20 s per Feature,
mostly the post-Submission wait (30 s of a 5 min 40 s run, measured). Going
lower spends the token while a Feature is submitted, for seconds nobody
notices.

**So:** 10000 for one Mason home on a token. Idle no longer spends the
budget, so the quota is not what holds the floor: usefulness is, and a
submitted Feature still is (its judgement counts). Several homes on the same
token add up: multiply the `submitted` and worst-case columns by their count
and stay under half the budget. The journal is not a reason either way: quiet
ticks are folded into one `idle` line a minute (`src/loop/journal.ts`).

A work line with CI is not waited for by this interval: `ci-green` polls the
checks inside its own Gate, every `--poll-ms` (15 s by default), until they
settle or its timeout ends the attempt.

## Slots

Commands mason spawns and never imports: the Planner, the Builder, each Gate,
and — when an Authority is enabled — the Publisher and the Refresher. Every one
reads argv and answers with **one JSON object on stdout**; an exit code alone is
not the contract. mason does not pick a producer, and a slot may be written in
anything that can print a line.

Examples ship in [`@bluewombat/slots`](../../plugins/slots/README.md), installed with Host —
the shipped roles and agents (Cursor CLI, Claude Code), the shipped Gates, and
their options. What follows is what Host guarantees them.

```json
"planner": {
  "cmd": ["node", "./node_modules/@bluewombat/slots/planners/one-subtask.mjs"],
  "timeoutMs": 600000
},
"builder": {
  "producer": {
    "cmd": [
      "node", "./node_modules/@bluewombat/slots/builders/producer.mjs",
      "--",
      "node", "./node_modules/@bluewombat/slots/agents/claude.mjs"
    ],
    "timeoutMs": 600000
  }
}
```

`builder.repair` is required too, with its own `cmd` and `timeoutMs`. The
composition with `--` is the same.

### Builder

Spawned in the Subtask workspace with `--intention`, `--definition-of-done`,
`--id`, `--attempt`, and `--context`. On a retry it also gets `--report` and
`--report-from`: what refused the last pass, and which Gate said it. Exit 0
means the Gates may run.

A Builder **leaves its work uncommitted in the workspace**. That is where
Integrator folds from, and it is what the Gates read: a commit moves `HEAD` and
hides the change from them.

The config always names a producer (and a repair). Implementer can still run a
Task as its Gate sequence alone — that is the first judgement of the assembled
feature, which makes nothing.

### Assembly fix

Spawned in the feature workspace when a judgement of the whole refused it
(`--report`, `--report-from`). Same argv as a Builder otherwise. Host hands
Implementer `assembly.fix` as that pass's only agent: there is no first-pass
producer at this moment. The refusal it repairs may have come from an
Authority or from `assembly.validate`.

### Assembly validate

Spawned in the feature workspace after align, with or without an Authority —
`--intention`, `--id`, `--attempt`, `--context`. No `--report`: it is a
read-only review, not a repair, and takes nothing a producer would. Optional.
Its verdict is not the exit code alone: the slot reads what the agent itself
answered and maps a refusal through the Builder failure contract, so a review
that completes cleanly but finds a problem is still a refusal.

### Gates

Two sequences, because a Subtask and the feature it assembles into are not the
same situation. `builder.gates` runs on each Subtask; `assembly.gates` on the
assembled feature. Put the Project's own checks in `builder.gates`, and fill
`assembly.gates` with what only makes sense on the whole — `ci-green` reads the
checks the work line ran on what the Publisher placed, so it belongs there.

Every Gate is told `--stage unit` or `--stage assembly` alongside `--id`,
`--attempt`, `--gate-id`, `--intention` and `--definition-of-done`. Most have no
use for it. `workspace-changed` does: "nothing changed" means nothing was done
in a unit, and is the correct outcome for an assembly that needed nothing.

`init` writes an empty list; add a Gate when the Project has a check.

Every child carries its own ceiling and no other. A Gate entry may name a
`timeoutMs`; without one it takes its sequence's `defaultTimeoutMs`, and a Gate
that ends up with neither is refused when the config loads. Nothing is derived
from what another child left behind, so a slow producer can no longer leave its
Gates a millisecond to answer in.

What bounds a Subtask is therefore what you wrote:
`builder.maxAttempts × (builder.producer.timeoutMs + Σ builder.gates timeouts)`.
A repair and an assembly fix each carry their own `timeoutMs`. An assembly fix
is bounded the same way from `assembly.maxAttempts` and `assembly.fix`.

```json
{
  "id": "ci-green",
  "argv": [
    "node",
    "./node_modules/@bluewombat/slots/gates/ci-green.mjs",
    "--token-env",
    "MASON_GITHUB_TOKEN",
    "--require-checks"
  ],
  "timeoutMs": 900000
}
```

### Planner

FeatureStandard in, a Plan out. It is given `--key`, `--intention`,
`--title` and `--max-units`. `init` writes the
bootstrap Planner — one Subtask that is the intention — from
`@bluewombat/slots/planners/one-subtask.mjs`.

### Describer

How a delivered feature describes itself — the words the manager puts on the
Submission and on the fold — is the Project's, not Host's. Three levels, one
key, `authority.describe`:

| `authority.describe`                   | The Submission's description                                                            | Cost                      |
| -------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------- |
| not set                                | the manager's own default: the issue's title, its body as the human wrote it            | none                      |
| `messages/conventional.mjs`            | `<type>: <title>` (`--scope`, `--type`), the body as written                            | none                      |
| `messages/git-producer.mjs -- <agent>` | an agent reads the git diff and writes both under `--rules-file` — the team's guideline | one agent run per feature |

It is an argv like `publish` and `refresh`, bounded by the global `timeoutMs`.
Host spawns it once per feature, in the feature workspace, when the work is
offered — with `--id`, `--title`, `--intention` and `--target` (the work line
it lands on) — and takes one line back: `{ "subject": "…", "body": "…" }`.
Host hands that description to the manager as is; what it becomes is the
manager's business (for GitHub: the squash's title and message, the pull
request's first paragraph). A slot that fails is skipped and the journal says
so.

Subtasks are never described: their folds are folded again into the
feature's, so their message is the Subtask's intention — its headline when
the Planner wrote one (a line, a blank line, the rest: the shape of a commit),
else its first sentence cut at a word, no markdown. That headline is also what
the tracker's Plan, the progress comments and the Submission's change list
show, so a Planner is asked to write one.

### Write another slot

Anything that prints the right line. The plumbing a slot written in Node would
otherwise repeat is [`@bluewombat/slot-kit`](../slot-kit/README.md).


## Submissions

Without an Authority, a finished feature is folded straight into WorkLineStable
and that is the end of it. With one, the assembled feature is **offered** to an
outside judge first, and only an `accepted` verdict lets it into the work line.

It is **declared**, never inferred:

```json
"authority": {
  "enabled": true,
  "publish": ["node", "./node_modules/@bluewombat/slots/publishers/git.mjs"],
  "refresh": ["node", "./node_modules/@bluewombat/slots/refreshers/git.mjs"]
}
```

`enabled` says whether the Project has an outside judge at all. `publish` is the
slot that puts the work in front of it, and `refresh` the one that reads back
what it accepted — both are required when enabled. The manager must declare
`submit` and `fold` — `@bluewombat/manager-github` does. Enabled against a manager
that does not, or with nothing naming the work line it is offered to, is refused
before the run starts rather than quietly folded locally.

### The reference work line

With an Authority, the reference work line lives where the Authority is, and the
directory here is only Host's copy of it. A manager that names that reference
(`referenceManager`, in words the Isolation strategy reads — `remote` and
`branch` for `@bluewombat/isolation-git`) spares the config from repeating them:
leave `workLine.stable` and `workLine.branch` out, and Host keeps the copy at
`<home>/work-line`, fetched on the first run, and refreshed before every pass that has work to drive. The
Refresher's `--target` and the Submission's target are read from the reference.

Everything about that copy is settled before a run writes anything: a key the
strategy does not know, a branch the remote does not have, a `workLine.branch`
that disagrees with the reference, or a `workLine.stable` that is not a copy of
it each stop `mason run` at boot, and `mason doctor` reports the same offline
(`reference`, `work line`). Without a reference, `workLine.stable` is required
and is the operator's directory, as before.

```
assembled → align → assembly.validate (optional, local)
              refused  → assembly.fix, then align again, then validate again
              accepted → Publisher places the work → manager opens the Submission
          → submitted, and the run comes back to it on each poll
              assembly.gates judge what was published
              refused  → assembly.fix, then the same Submission is offered again
              accepted → the Authority folds it → done
```

Neither half judges: that is what `assembly.gates` are for. The Authority places
and folds; a Gate says whether the fold may happen. `assembly.validate`, when
declared, judges before either half — the same verdict has the same fate
whether or not there is an Authority to offer the work to afterwards. After the
Authority folds, Host brings its copy of the work line up to date with a
fast-forward — the work line moved where the Authority is, and the next
Isolation must start from that version, not from a copy left behind.

A refusal is not a second failure path: its report reaches `assembly.fix`
exactly as a Gate's report reaches `builder.repair`. After `maxRefusals`
refusals the feature escalates with that report as its Trace, and `done` names
the Submission rather than a directory on the machine that ran.

## Write another manager

Host loads whatever `manager` names, as long as it exports `createManager`. The
contract and a worked example are in
[`@bluewombat/manager-kit`](../manager-kit/README.md). Nothing in Host changes.

## Import

```ts
import { openHost } from "@bluewombat/runtime";

const host = await openHost({
  manager: "@bluewombat/manager-fake",
  managerOptions: { source: "./.mason/source", target: "./.mason/threads" },
  // …paths and slots
});
await host.runOnce();
```

`manager` also takes an already-loaded module, which is how a test drives Host
without resolving a package.

## Stack

Repository stack — TypeScript, Node 24.20, Biome, `node:test`. See [docs/DEVELOPMENT.md](../../../docs/DEVELOPMENT.md).

## Setup

From the repository root:

```bash
nvm use
npm install
```

## Commands (development)

| Task      | Command          |
| --------- | ---------------- |
| Lint      | `npm run lint`   |
| Format    | `npm run format` |
| Typecheck | `npm run tsc`    |
| Test      | `npm test`       |
| Build     | `npm run build`  |

Binary after build: `dist/cli.js` (package bin name `mason`).

## Layers

Host is the most tangled package by nature: it is where everything else meets.
So it is cut into four layers, and imports point one way only:

```
operator  →  loop  →  plugins  →  config
```

A file imports from its own layer or a lower one, never a higher one. That is
the whole rule. `scripts/check-host.mjs` enforces it in `npm run lint`, so a
change that breaks it does not merge.

| Layer                | Holds                                                                                                                                                     | Does not hold                                                    | May import                                    |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------- |
| `config/`            | What a Project wrote: argv, `mason.config.yaml`, discovery, `HostOptions`. Pure: YAML in, options out                                                     | A runtime value (a Journal, a Port, a process handle)            | Node, `manager-kit` types                     |
| `plugins/`           | Load a package by name and check its shape: a manager, an isolation strategy                                                                              | What to do with the loaded thing                                 | `config`                                      |
| `loop/`              | The process: listen → probe → adapt → admit → run → report; composition (`open-host`, `transformers`, Authority, work line, lock, Cursor, journal, trace) | A command a human types; a string a human reads about the config | `plugins`, `config`, the kernel, Transformers |
| `operator/`          | Tools for a human: `init`, `setup`, `doctor`, `watch` / `status`, `log`, `cancel`, `release`, `board`, the terminal prompt                                | Anything the loop needs — the loop cannot see this layer         | everything below                              |
| `index.ts`, `cli.ts` | The package surface and the dispatch. Nothing else sits at the top of `src/`                                                                              | Logic                                                            | everything                                    |

Host's code names no plugin. A manager, an isolation strategy, a persistence
backend, the shipped slots: each is loaded by the name a config gives, through
`plugins/`, never imported. The names Host falls back to — the two isolation
strategies `init` writes, the default `persist`, the bootstrap Planner — are
strings in `config/defaults.ts` and nowhere else; `check-host.mjs` refuses an
import of any of them and a spelled-out name anywhere else. Host's
`package.json` declares exactly those defaults, so a config `init` wrote runs
with nothing else installed. A manager has no default, so it is not declared.

Two consequences worth stating, because they are the easy mistakes:

- A test hands `openHost` its film through the second argument
  (`openHost(options, { journal })`), never through `HostOptions`. Options are
  what a Project can write; a Journal is not.
- "Is this path a git work line?" (`inspectWorkLine`) belongs to the loop, and
  `doctor` and `init` ask the loop. The remote helpers that only `init` and
  `doctor` need (`git-remote.ts`) stay in `operator/`.

### Working in Host

Each kind of change has one place, and the order below is the order that keeps
the layers true. Skipping ahead is how a package like this one tangles.

1. **A change to the loop** touches `loop/` and its tests, nothing above. If it
   needs a new value from the config, add the key in `config/` first, with its
   parse test, then read it in `loop/`.
2. **A new pluggable thing** is a `Shape` in `plugins/` — a name for refusals
   and a `check` of the imported module — loaded by `plugins/load.ts` like the
   others; a config key that names it; a name in `config/defaults.ts` when it
   has a default; and a call from `loop/open-host.ts`. Host imports the
   default package so the config `init` writes runs, and never imports a
   plugin from code. The strategy's `refOf` is the model: the plugin says, Host
   relays.
3. **A new command for a human** is a file in `operator/`. It may read the
   config, load plugins, and open the loop; it may not be needed by any of
   them.
4. **Splitting `operator/` into its own package** comes after all of these,
   and only if it keeps growing. `init` needs the config writers and `doctor`
   the plugin loaders, and the layer rule already gives the isolation a
   package would.

## Layout

```
SPECS.md                 behavioural contract
README.md                how to install, configure and run; the layers above
src/
  index.ts               the package surface
  cli.ts                 mason run | watch | status | log | cancel | release | init | setup | doctor
  config/                argv, JSON config, config discovery → HostOptions; defaults: the plugin names Host ships with
  plugins/               load: the one loader; manager, isolation, persist: one shape each; discover
  loop/                  open-host (composition), tick (the loop), deliveries, drive, probe, report, authority, work-line, cursor, lock, journal (the film), streams (what a child said), trace, transformers
  operator/              init, setup, doctor, live (watch / status), log, film, cancel, release, board, prompt, git-remote
fixtures/                stand-in slots for the loop's tests
```
